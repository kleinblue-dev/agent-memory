/**
 * lib/recall.mjs — lexical recall for long-term memory (zero dependencies).
 *
 * Ported 1:1 from dsh-plugin-personal-agent 1.4.1 `lib/recall.js` so the two
 * implementations stay behaviourally identical (see tests/differential.test.mjs).
 *
 * Why lexical instead of embeddings:
 *   - the host has no embedding service, and prompt assembly is synchronous, so
 *     any network/model call would either block the turn or become stale;
 *   - precision beats recall here: one wrong memory makes the agent wrong about
 *     the user, which is worse than forgetting. Hence the hard "direct hit or tag
 *     hit required" gate below — synonyms may rank a hit, never create one.
 */

const STOP_BIGRAMS = new Set([
  '的我', '我的', '你是', '是我', '了的', '了。', '就是', '可以', '这个', '那个', '什么', '怎么',
  '因为', '所以', '如果', '然后', '一个', '我们', '他们', '自己', '没有', '不是', '还是', '这些',
  '那些', '这样', '那样', '一下', '现在', '时候', '已经', '需要', '应该', '可能', '是不', '在的',
])

const MIN_SCORE = 0.12
/** Cost of the block wrapper itself; deducted from the budget before any hit is added. */
const WRAPPER_TOKENS = 48

/**
 * Curated bilingual aliases. Lexical recall cannot cross languages by itself:
 * "记忆" would never match an entry written as "memory". A hand-maintained map is
 * the cheapest bridge and stays predictable — an auto-generated alias list would
 * inject wrong memories, which is worse than silence.
 */
export const SYNONYMS = {
  记忆: ['memory', 'remember', 'mem'],
  偏好: ['preference', 'prefer'],
  时区: ['timezone', 'tz'],
  插件: ['plugin', 'bundle', 'extension'],
  会话: ['session', 'conversation'],
  任务: ['task', 'todo', 'job'],
  提醒: ['reminder', 'schedule', 'cron'],
  权限: ['permission', 'approval', 'access'],
  模型: ['model', 'llm'],
  成本: ['cost', 'budget', 'token'],
  测试: ['test', 'check'],
  报错: ['error', 'bug', 'fail'],
  部署: ['deploy', 'install'],
  文档: ['doc', 'documents', 'readme'],
  项目: ['project', 'workspace'],
  搜索: ['search', 'query'],
  历史: ['history', 'past'],
  版本: ['version', 'release'],
}

/** English → Chinese half of the same table, derived so it cannot drift. */
const ALIASES = (() => {
  const map = new Map()
  for (const [chinese, english] of Object.entries(SYNONYMS)) {
    if (!map.has(chinese)) map.set(chinese, new Set())
    for (const alias of english) {
      map.get(chinese).add(alias)
      if (!map.has(alias)) map.set(alias, new Set())
      map.get(alias).add(chinese)
    }
  }
  return map
})()

/** Weight of an alias hit relative to a direct hit. */
const ALIAS_WEIGHT = 0.6

const KIND_IMPORTANCE = { person: 0.8, preference: 0.85, fact: 0.6, task: 0.5, event: 0.4 }
/** Half-life in hours per kind: events/tasks age out, identity facts do not. */
const HALF_LIFE_HOURS = { person: 180 * 24, preference: 120 * 24, fact: 90 * 24, event: 30 * 24, task: 7 * 24 }

export const RECALL_DEFAULTS = {
  k: 3,
  budgetTokens: 300,
  toolK: 8,
  toolBudgetTokens: 800,
  minScore: MIN_SCORE,
  wrapperTokens: WRAPPER_TOKENS,
}

function clamp01(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.min(1, Math.max(0, number))
}

/**
 * Importance is the tiebreaker that keeps an acceptance standard ahead of trivia.
 * Generative Agents rated it with an LLM; here it is a kind prior plus tag and
 * confidence bonuses, overridable by the writer.
 */
export function defaultImportance(entry = {}) {
  const base = KIND_IMPORTANCE[entry.kind] ?? 0.5
  const tagBonus = (entry.tags?.length ?? 0) > 0 ? 0.1 : 0
  const confidence = [0, 1, 2].includes(entry.confidence) ? [0, 0.05, 0.1][entry.confidence] : 0.05
  return Math.round(clamp01(base + tagBonus + confidence) * 100) / 100
}

/** Exponential decay with a per-kind half-life; 1 at write time. */
export function decayOf(entry = {}, now = Date.now()) {
  const halfLifeMs = (HALF_LIFE_HOURS[entry.kind] ?? 60 * 24) * 3600 * 1000
  const age = Math.max(0, now - (entry.updatedAt ?? entry.createdAt ?? now))
  return Math.pow(0.5, age / halfLifeMs)
}

/** Direct tokens weight 1, aliases weight 0.6; the map is the query signature. */
export function expandWeights(queryText) {
  const weights = new Map()
  for (const token of tokenize(queryText)) if (!weights.has(token)) weights.set(token, 1)
  const additions = []
  for (const [token, weight] of weights) {
    const aliases = ALIASES.get(token)
    if (!aliases) continue
    for (const alias of aliases) if (!weights.has(alias)) additions.push([alias, weight * ALIAS_WEIGHT])
  }
  for (const [token, weight] of additions) if (!weights.has(token)) weights.set(token, weight)
  return weights
}

/**
 * English function words carry no topic signal. Without this filter a short
 * English sentence overlaps almost any query and its small vocabulary inflates
 * coverage, so noise gets injected into unrelated turns.
 */
const ASCII_STOP = new Set([
  'the', 'and', 'for', 'you', 'your', 'with', 'that', 'this', 'these', 'those', 'was', 'were', 'are', 'is', 'it',
  'its', 'to', 'of', 'in', 'on', 'at', 'by', 'from', 'or', 'as', 'be', 'been', 'being', 'not', 'no', 'yes', 'has',
  'have', 'had', 'but', 'if', 'then', 'than', 'so', 'what', 'which', 'who', 'when', 'where', 'why', 'how', 'all',
  'any', 'some', 'more', 'most', 'other', 'into', 'over', 'after', 'before', 'up', 'down', 'out', 'just', 'also',
  'very', 'too', 'only', 'own', 'same', 'such', 'do', 'does', 'did', 'done', 'doing', 'can', 'could', 'would',
  'should', 'will', 'shall', 'may', 'might', 'must', 'let', 'me', 'my', 'we', 'our', 'us', 'he', 'she', 'him',
  'her', 'they', 'them', 'their', 'there', 'here', 'now', 'new', 'one', 'two', 'get', 'got', 'make', 'made',
  'use', 'used', 'using', 'about', 'like', 'want', 'need', 'see', 'saw', 'say', 'said', 'tell', 'told', 'well',
  'good', 'ok', 'okay', 'hi', 'hello', 'thanks', 'thank', 'please', 'sure', 'still', 'even', 'because', 'while',
  'during', 'without', 'within', 'between', 'through', 'yet', 'per', 'via', 'etc',
])

/** CJK bigrams (+ single-char runs) and lowercase ASCII words; stop words dropped. */
export function tokenize(value) {
  const text = String(value ?? '').toLowerCase()
  const tokens = []
  for (const match of text.matchAll(/[a-z0-9_.-]{2,}/g)) {
    if (ASCII_STOP.has(match[0])) continue
    tokens.push(match[0])
  }
  for (const match of text.matchAll(/[\u4e00-\u9fff]+/g)) {
    const run = match[0]
    if (run.length === 1) {
      tokens.push(run)
      continue
    }
    for (let index = 0; index + 1 < run.length; index += 1) {
      const bigram = run.slice(index, index + 2)
      if (!STOP_BIGRAMS.has(bigram)) tokens.push(bigram)
    }
  }
  return tokens
}

function tokenSet(value) {
  return new Set(tokenize(value))
}

/** Rough token estimate; CJK is ~1 token/char, so divide by 1.6 and round up. */
export function estimateTokens(text) {
  return Math.ceil(String(text ?? '').length / 1.6)
}

export function scoreEntry(entry, weights, now = Date.now()) {
  const entryTokens = tokenSet(`${entry.text} ${(entry.tags ?? []).join(' ')}`)
  let matched = 0
  let totalWeight = 0
  let directHits = 0
  for (const [token, weight] of weights) {
    totalWeight += weight
    if (!entryTokens.has(token)) continue
    matched += weight
    if (weight >= 1) directHits += 1
  }
  const tagHit = (entry.tags ?? []).some((tag) => weights.has(String(tag).toLowerCase())) ? 1 : 0
  // Hard gate: aliases and modifiers may RANK a hit, never CREATE one.
  if (directHits === 0 && tagHit === 0) return 0
  // Symmetric normalization: dividing by the whole query makes a long user
  // message unmatchable (a 400-token entry can never cover 18% of a 1600-char message).
  const denominator = Math.min(totalWeight, entryTokens.size)
  const relevance = denominator === 0 ? 0 : matched / denominator
  const recency = decayOf(entry, now)
  const importance = clamp01(entry.importance ?? defaultImportance(entry))
  // Product form (Generative Agents): relevance dominates, recency/importance modulate.
  return relevance * (0.55 + 0.45 * recency) * (0.6 + 0.4 * importance)
}

/** @returns {{ entry: object, score: number }[]} at most `k` hits within `budgetTokens`. */
export function recall(entries, query, options = {}) {
  const k = options.k ?? RECALL_DEFAULTS.k
  const budgetTokens = options.budgetTokens ?? RECALL_DEFAULTS.budgetTokens
  const now = options.now ?? Date.now()
  const minConfidence = options.minConfidence ?? 0
  const text = String(query ?? '').trim()
  if (!text || !Array.isArray(entries) || entries.length === 0) return []
  const weights = expandWeights(text)
  if (weights.size === 0) return []

  const scored = entries
    .filter((entry) => !entry.validUntil)
    // Auto-injection only spends context on statements the user confirmed. An
    // unconfirmed guess injected silently is how an agent ends up confidently
    // wrong about its own user; the tool path can still read them.
    .filter((entry) => minConfidence === 0 || (entry.confidence ?? 1) >= minConfidence)
    .map((entry) => ({ entry, score: scoreEntry(entry, weights, now) }))
    .filter((hit) => hit.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)

  const picked = []
  let spent = 0
  const available = Math.max(0, budgetTokens - WRAPPER_TOKENS)
  for (const hit of scored) {
    const line = renderLine(hit.entry)
    const cost = estimateTokens(line)
    if (picked.length >= k) break
    if (spent + cost > available) continue
    picked.push(hit)
    spent += cost
  }
  return picked
}

export const KIND_LABEL = { fact: '事实', preference: '偏好', event: '事件', task: '任务', person: '人物' }

export function renderLine(entry) {
  const label = KIND_LABEL[entry.kind] ?? entry.kind
  const uncertain = entry.confidence === 0 ? '（待确认）' : ''
  return `- [mem:${entry.id}] (${label}) ${entry.text}${uncertain}`
}

/** The injected block. Returns '' when nothing is relevant, so a quiet turn costs zero tokens. */
export function renderRecallBlock(hits) {
  if (!Array.isArray(hits) || hits.length === 0) return ''
  const lines = hits.map((hit) => renderLine(hit.entry))
  return [
    '<long-term-memory note="可能过时或不准；与用户当前说法冲突时以用户为准，并调用 memory op=remember 更新">',
    ...lines,
    '</long-term-memory>',
  ].join('\n')
}
