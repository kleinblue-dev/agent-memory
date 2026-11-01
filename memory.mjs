#!/usr/bin/env node
/**
 * memory.mjs — long-term memory for any agent, as a CLI + library.
 *
 * Extracted from dsh-plugin-personal-agent 1.4.1 (Host-only memory layer) so the
 * same brain works without the plugin: same on-disk format, same recall algorithm,
 * same governance rules. The plugin and this CLI can share one directory.
 *
 * Commands
 *   doctor                                   what this store is and whether it is usable
 *   remember <text> [--kind K] [--tags a,b] [--subject S] [--confidence 0|1|2]
 *                    [--importance 0..1] [--session ID]
 *   recall <query> [--k N] [--budget N] [--min-confidence N]
 *   inject <query> [--k N] [--budget N]     the prompt block only (auto-injection semantics)
 *   list [--limit N] [--all]
 *   show <id>
 *   forget <id>
 *   profile get | profile set key=value... | profile json '{"name":"..."}'
 *   stats
 *   export [--out FILE]
 *   import <FILE> [--dry-run] [--force]
 *   init
 *
 * Global flags: --root DIR  --json  --help  --version
 * Exit codes: 0 ok · 1 usage/user error · 2 environment/IO error
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

import { resolveRoot } from './lib/root.mjs'
import { openStore, entryId, normalize, KINDS, MAX_TEXT, SCHEMA_VERSION } from './lib/store.mjs'
import {
  defaultImportance,
  estimateTokens,
  recall as recallHits,
  renderLine,
  renderRecallBlock,
  RECALL_DEFAULTS,
} from './lib/recall.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const VERSION = '1.0.0'
const MAX_LIST = 20
const MAX_TOOL_K = RECALL_DEFAULTS.toolK

const VALUE_FLAGS = new Set([
  'root', 'kind', 'tags', 'subject', 'confidence', 'importance', 'session',
  'k', 'budget', 'min-confidence', 'limit', 'out', 'text',
])
const BOOL_FLAGS = new Set([
  'json', 'help', 'version', 'all', 'include-superseded', 'dry-run', 'force',
])

class UsageError extends Error {}
class EnvError extends Error {}

function parseArgv(argv) {
  const flags = {}
  const positionals = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--') {
      positionals.push(...argv.slice(index + 1))
      break
    }
    if (!token.startsWith('--')) {
      positionals.push(token)
      continue
    }
    const body = token.slice(2)
    const eq = body.indexOf('=')
    const name = (eq === -1 ? body : body.slice(0, eq)).toLowerCase()
    if (eq !== -1) {
      flags[name] = body.slice(eq + 1)
      continue
    }
    if (BOOL_FLAGS.has(name)) {
      flags[name] = true
      continue
    }
    if (VALUE_FLAGS.has(name)) {
      if (index + 1 >= argv.length) throw new UsageError(`缺少参数值：--${name}`)
      flags[name] = argv[index + 1]
      index += 1
      continue
    }
    throw new UsageError(`未知参数：--${name}`)
  }
  return { flags, positionals }
}

function out(text = '') {
  process.stdout.write(text.endsWith('\n') || text === '' ? text : `${text}\n`)
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function requireText(flags, positionals, what = 'text') {
  const joined = positionals.join(' ').trim()
  const value = (flags.text ?? joined).trim()
  if (!value) throw new UsageError(`${what} 不能为空`)
  return value
}

function intFlag(flags, name, fallback) {
  if (flags[name] === undefined) return fallback
  const value = Number(flags[name])
  if (!Number.isFinite(value) || value <= 0) throw new UsageError(`--${name} 必须是正整数`)
  return Math.floor(value)
}

// ── commands ────────────────────────────────────────────────────────────────

function cmdDoctor({ store, rootInfo }) {
  const stats = store.stats()
  const writable = (() => {
    try {
      const probe = join(store.root, '.write-test')
      writeFileSync(probe, 'ok', 'utf8')
      unlinkSync(probe)
      return true
    } catch {
      return false
    }
  })()
  const profile = store.profileGet()
  const rows = [
    ['node', process.version],
    ['store root', `${stats.root}  (来源: ${rootInfo.source})`],
    ['writable', writable ? 'yes' : 'NO — 检查目录权限'],
    ['entries', `活动 ${stats.active} / 历史 ${stats.superseded} / 文件 ${stats.total}`],
    ['by kind', JSON.stringify(stats.byKind)],
    ['corrupt files', stats.corrupt ? `${stats.corrupt}（已跳过）` : '0'],
    ['schemaVersion', String(profile.schemaVersion ?? SCHEMA_VERSION)],
    ['profile fields', Object.keys(profile).filter((key) => key !== 'schemaVersion' && key !== 'updatedAt').join(', ') || '(空)'],
  ]
  if (flagsJson()) {
    printJson({ node: process.version, root: stats.root, source: rootInfo.source, writable, ...stats, profile })
  } else {
    for (const [name, value] of rows) out(`  ${name.padEnd(15)} ${value}`)
    out(`\n结论：${writable ? '可用' : '不可写'}`)
  }
  return writable ? 0 : 2
}

function cmdRemember({ store, flags, positionals }) {
  const text = requireText(flags, positionals)
  if (text.length > MAX_TEXT) {
    throw new UsageError(`text 超过 ${MAX_TEXT} 字（当前 ${text.length}）。记忆要一行一条、可验证；拆成多条再写。`)
  }
  const result = store.put({
    text,
    kind: flags.kind,
    tags: flags.tags ? String(flags.tags).split(',').map((tag) => tag.trim()).filter(Boolean) : undefined,
    confidence: flags.confidence === undefined ? undefined : Number(flags.confidence),
    importance: flags.importance === undefined ? undefined : Number(flags.importance),
    subject: flags.subject,
    sourceSessionId: flags.session,
  })
  if (flagsJson()) {
    printJson({ created: result.created, superseded: result.superseded ?? null, ...result.record })
    return 0
  }
  const verb = result.created ? '已记住' : '已更新'
  // 同 id 重写时，库内部的取代目标可能指向自己（插件原实现的已知怪癖）；
  // 对用户没有意义，CLI 不展示它，避免出现「已取代 [mem:自己]」。
  const replaced = result.superseded && result.superseded !== result.record.id
    ? `；已取代 [mem:${result.superseded}]`
    : ''
  out(`${verb} [mem:${result.record.id}]（${result.record.kind}，重要度 ${result.record.importance}${replaced}；活动 ${store.stats().active} 条）`)
  return 0
}

function textHits(hits) {
  if (hits.length === 0) return '没有匹配的记忆。'
  const block = renderRecallBlock(hits)
  const scored = hits.map((hit) => `- [mem:${hit.entry.id}] score=${hit.score.toFixed(2)}`).join('\n')
  return `${block}\n\n命中明细：\n${scored}`
}

function cmdRecall({ store, flags, positionals }) {
  const query = requireText(flags, positionals, 'query')
  const k = Math.min(intFlag(flags, 'k', RECALL_DEFAULTS.toolK), MAX_TOOL_K)
  const budgetTokens = intFlag(flags, 'budget', RECALL_DEFAULTS.toolBudgetTokens)
  const minConfidence = flags['min-confidence'] === undefined ? 0 : Number(flags['min-confidence'])
  const hits = recallHits(store.list(), query, { k, budgetTokens, minConfidence })
  if (flagsJson()) {
    printJson({
      query, k, budgetTokens, minConfidence, count: hits.length,
      hits: hits.map((hit) => ({ id: hit.entry.id, score: Number(hit.score.toFixed(4)), line: renderLine(hit.entry), entry: hit.entry })),
      block: renderRecallBlock(hits),
    })
  } else {
    out(textHits(hits))
  }
  return hits.length ? 0 : 0
}

/** Auto-injection semantics: k=3, 300 tokens, only user-confirmed entries. Prints nothing when quiet. */
function cmdInject({ store, flags, positionals }) {
  const query = requireText(flags, positionals, 'query')
  const k = Math.min(intFlag(flags, 'k', RECALL_DEFAULTS.k), RECALL_DEFAULTS.toolK)
  const budgetTokens = intFlag(flags, 'budget', RECALL_DEFAULTS.budgetTokens)
  let hits = recallHits(store.list(), query, { k, budgetTokens, minConfidence: 1 })
  // 整块预算兜底：插件原实现的 300 只约束命中行（wrapper 文本不计，实测整块可到 313）。
  // CLI 这里多一层：整块 estimateTokens 超过预算就丢掉最后一条，保证「注入块 ≤ 预算」这句话是真的。
  let block = renderRecallBlock(hits)
  while (hits.length > 0 && estimateTokens(block) > budgetTokens) {
    hits = hits.slice(0, -1)
    block = renderRecallBlock(hits)
  }
  if (flagsJson()) printJson({ query, count: hits.length, tokens: estimateTokens(block), budgetTokens, block, ids: hits.map((hit) => hit.entry.id) })
  else if (block) process.stdout.write(`${block}\n`)
  return 0
}

function renderList(entries, includeInactive = false) {
  if (entries.length === 0) return '记忆库为空。'
  return entries
    .map((entry) => {
      const retired = entry.validUntil ? ` ~~已被 [mem:${entry.supersededBy ?? '?'}] 取代~~` : ''
      const subject = entry.subject ? ` subject=${entry.subject}` : ''
      const importance = entry.importance ?? defaultImportance(entry)
      return `- [mem:${entry.id}] (${entry.kind}, imp ${importance}${subject}) ${entry.text}${retired}`
    })
    .join('\n')
}

function cmdList({ store, flags }) {
  const limit = Math.min(intFlag(flags, 'limit', MAX_LIST), MAX_LIST)
  const includeInactive = flags.all === true || flags['include-superseded'] === true
  const entries = store.list({ includeInactive }).slice(0, limit)
  const stats = store.stats()
  if (flagsJson()) {
    printJson({ active: stats.active, superseded: stats.superseded, total: stats.total, byKind: stats.byKind, entries })
    return 0
  }
  out(`${renderList(entries, includeInactive)}\n\n活动 ${stats.active} 条 / 历史 ${stats.superseded} 条；按类型：${JSON.stringify(stats.byKind)}`)
  return 0
}

function cleanId(raw) {
  return String(raw ?? '').replace(/^mem:/, '').trim()
}

function cmdShow({ store, positionals, flags }) {
  const id = cleanId(positionals[0])
  if (!id) throw new UsageError('show 需要 id（形如 mem:ab12cd34ef56）')
  const entry = store.get(id)
  if (!entry) {
    out(`未找到 [mem:${id}]`)
    return 1
  }
  printJson({ ...entry, _line: renderLine(entry) })
  return 0
}

function cmdForget({ store, positionals }) {
  const id = cleanId(positionals[0])
  if (!id) throw new UsageError('forget 需要 id（形如 mem:ab12cd34ef56）')
  const removed = store.remove(id)
  if (!removed) {
    out(`未找到 [mem:${id}]，可能已删除。`)
    return 1
  }
  out(`已删除 [mem:${id}]（剩余 ${store.stats().total} 条）`)
  return 0
}

const PROFILE_FIELDS = new Set(['name', 'timezone', 'locale', 'preferences', 'notes'])

function cmdProfile({ store, positionals, flags }) {
  const sub = positionals[0] ?? 'get'
  if (sub === 'get') {
    printJson(store.profileGet())
    return 0
  }
  let patch
  if (sub === 'set') {
    patch = {}
    for (const pair of positionals.slice(1)) {
      const eq = pair.indexOf('=')
      if (eq === -1) throw new UsageError(`profile set 需要 key=value，收到 ${pair}`)
      patch[pair.slice(0, eq)] = pair.slice(eq + 1)
    }
  } else if (sub === 'json') {
    try {
      patch = JSON.parse(positionals.slice(1).join(' '))
    } catch {
      throw new UsageError('profile json 需要合法 JSON 对象')
    }
  } else if (sub === 'update') {
    patch = flags.patch ? JSON.parse(flags.patch) : {}
  } else {
    throw new UsageError('profile 支持：get | set key=value… | json \'{"name":"…"}\'')
  }
  const unknown = Object.keys(patch).filter((key) => !PROFILE_FIELDS.has(key))
  if (unknown.length) out(`提示：非标准字段也会写入 profile：${unknown.join(', ')}`)
  printJson(store.profileSet(patch))
  return 0
}

function cmdStats({ store, flags }) {
  const stats = store.stats()
  if (flagsJson()) {
    printJson(stats)
  } else {
    out(`root   ${stats.root}`)
    out(`活动   ${stats.active}`)
    out(`历史   ${stats.superseded}`)
    out(`文件   ${stats.total}${stats.corrupt ? `（损坏 ${stats.corrupt}，已跳过）` : ''}`)
    out(`按类型 ${JSON.stringify(stats.byKind)}`)
  }
  return 0
}

function cmdExport({ store, flags }) {
  const entries = store.list({ includeInactive: true })
  const lines = entries.map((entry) => JSON.stringify(entry))
  const profile = store.profileGet()
  const profileKeys = Object.keys(profile).filter((key) => key !== 'schemaVersion' && key !== 'updatedAt')
  if (profileKeys.length) lines.push(JSON.stringify({ __profile__: profile }))
  const payload = lines.join('\n') + (lines.length ? '\n' : '')
  if (flags.out) {
    writeFileSync(resolve(String(flags.out)), payload, 'utf8')
    out(`已导出 ${entries.length} 条${profileKeys.length ? ' + profile' : ''} → ${resolve(String(flags.out))}`)
  } else {
    process.stdout.write(payload)
  }
  return 0
}

function cmdImport({ store, positionals, flags }) {
  const file = positionals[0]
  if (!file) throw new UsageError('import 需要文件路径（JSONL，每行一条记录；也接受 JSON 数组）')
  let raw
  try {
    raw = readFileSync(resolve(file), 'utf8')
  } catch (error) {
    throw new EnvError(`读不了 ${file}：${error.message}`)
  }
  let records
  const trimmed = raw.trim()
  if (trimmed.startsWith('[')) {
    records = JSON.parse(trimmed)
  } else {
    records = trimmed.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line))
  }
  if (!Array.isArray(records)) throw new UsageError('导入文件不是记录数组')
  const dryRun = flags['dry-run'] === true
  const force = flags.force === true
  const summary = { total: records.length, created: 0, replaced: 0, skipped: 0, invalid: 0, profile: 0 }
  for (const record of records) {
    // 导出文件里可以带一行 profile（迁移时画像也要跟着走）
    if (record && typeof record === 'object' && record.__profile__ && typeof record.__profile__ === 'object') {
      if (!dryRun) store.profileSet(record.__profile__)
      summary.profile += 1
      continue
    }
    // 按记录原样落盘：不经过 put()，否则历史条目会被复活、旧值会顶掉当前真相。
    const existing = typeof record?.id === 'string' ? store.get(record.id) : undefined
    if (dryRun) {
      const valid = record && typeof record === 'object'
        && typeof record.text === 'string' && record.text.length > 0
        && typeof record.kind === 'string'
      if (!valid) summary.invalid += 1
      else if (existing && !force) summary.skipped += 1
      else summary.created += 1
      continue
    }
    const result = store.importRecord(record, { force })
    if (result.ok) {
      if (result.created) summary.created += 1
      else summary.replaced += 1
    } else if (result.reason === 'invalid') {
      summary.invalid += 1
    } else {
      summary.skipped += 1
    }
  }
  if (flagsJson()) printJson({ dryRun, ...summary })
  else {
    out(`${dryRun ? 'DRY-RUN ' : ''}导入 ${summary.total} 行：新建 ${summary.created}，覆盖 ${summary.replaced}，`
      + `已存在跳过 ${summary.skipped}，非法 ${summary.invalid}${summary.profile ? `，profile ${summary.profile}` : ''}`)
  }
  return 0
}

function cmdInit({ store, flags }) {
  const profile = store.profileGet()
  if (!profile.schemaVersion) store.profileSet({})
  out(`记忆库就绪：${store.root}`)
  out(`条目目录：${join(store.root, 'entries')}`)
  return 0
}

// ── wiring ──────────────────────────────────────────────────────────────────

const HELP = `记忆层 CLI（long-term memory, zero-dependency）

用法：node memory.mjs [--root DIR] [--json] <command> [args]

  doctor                                         这个库在哪、能不能用
  remember <text> [--kind K] [--tags a,b] [--subject S]
                  [--confidence 0|1|2] [--importance 0..1] [--session ID]
  recall <query> [--k N] [--budget N] [--min-confidence N]   按关键词检索
  inject <query> [--k N] [--budget N]                       只输出可注入的提示块（无命中则无输出）
  list [--limit N] [--all]
  show <id>
  forget <id>
  profile get | profile set key=value… | profile json '{"name":"…"}'
  stats
  export [--out FILE]
  import <FILE> [--dry-run] [--force]
  init

kind：fact / preference / event / task / person
预算默认：inject k=3/300 tokens（只含 confidence>=1）；recall k=8/800
退出码：0 成功 · 1 用法/用户错误 · 2 环境/IO 错误`

let currentFlags = {}
function flagsJson() {
  return currentFlags.json === true
}

async function main(argv) {
  const { flags, positionals } = parseArgv(argv)
  currentFlags = flags
  if (flags.version) {
    out(`agent-memory ${VERSION}`)
    return 0
  }
  if (flags.help || positionals.length === 0) {
    out(HELP)
    return 0
  }
  const command = positionals[0]
  const rest = positionals.slice(1)
  if (command === 'help') {
    out(HELP)
    return 0
  }

  const rootInfo = resolveRoot({ flag: flags.root })
  let store
  try {
    store = openStore({ root: rootInfo.root })
  } catch (error) {
    process.stderr.write(`✗ 打不开记忆库 ${rootInfo.root}：${error.message}\n`)
    return 2
  }

  const ctx = { store, rootInfo, flags, positionals: rest }
  switch (command) {
    case 'doctor': return cmdDoctor(ctx)
    case 'remember': return cmdRemember(ctx)
    case 'recall': return cmdRecall(ctx)
    case 'inject': return cmdInject(ctx)
    case 'list': return cmdList(ctx)
    case 'show': return cmdShow(ctx)
    case 'forget': return cmdForget(ctx)
    case 'profile': return cmdProfile(ctx)
    case 'stats': return cmdStats(ctx)
    case 'export': return cmdExport(ctx)
    case 'import': return cmdImport(ctx)
    case 'init': return cmdInit(ctx)
    default:
      throw new UsageError(`未知命令：${command}（用 --help 看可用命令）`)
  }
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code },
  (error) => {
    if (error instanceof UsageError) {
      process.stderr.write(`✗ ${error.message}\n`)
      process.exitCode = 1
    } else if (error instanceof EnvError) {
      process.stderr.write(`✗ ${error.message}\n`)
      process.exitCode = 2
    } else {
      process.stderr.write(`✗ ${error?.stack ?? error}\n`)
      process.exitCode = 2
    }
  },
)
