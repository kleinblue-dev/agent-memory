/**
 * adversarial.test.mjs — 对抗验证：移植保真 + 真实数据安全 + 边界/破坏性场景。
 *
 * 两类测试：
 *   1. 普通 test：断言「当前实测行为」。断言失败 = 移植/CLI 行为与实测事实不符（回归）。
 *   2. `契约✗` test：断言「文档/设计契约要求的行为」。**当前预期失败**，失败即已确认的缺陷证据，
 *      修复后应转绿。这样缺陷不能被「测试只断言现状」掩盖。
 *
 * 只读真实记忆库：仅 export 到 verify/tmp（临时文件），不执行 remember/forget/import。
 * 临时文件全部落在 agent-memory/verify/tmp/test（退出时清理）。
 *
 *   node --test tests/adversarial.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import * as portRecall from '../lib/recall.mjs'
import * as portStore from '../lib/store.mjs'
import { resolveRoot } from '../lib/root.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT = join(HERE, '..')
const CLI = join(PROJECT, 'memory.mjs')
const WORK = join(PROJECT, 'verify', 'tmp', 'test')
mkdirSync(WORK, { recursive: true })
process.on('exit', () => { try { rmSync(WORK, { recursive: true, force: true }) } catch { /* ignore */ } })

function tempDir(prefix) {
  return mkdtempSync(join(WORK, prefix))
}

// 剥掉可能指向真实库的环境变量，任何 CLI 子进程都必须显式 --root 或显式 env 覆盖。
const BASE_ENV = (() => {
  const env = { ...process.env }
  for (const key of ['PA_MEMORY_ROOT', 'DSH_HOME', 'DSH_PROFILE_DIR']) delete env[key]
  return env
})()

function runCli(args, env = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...BASE_ENV, ...env },
    maxBuffer: 8 * 1024 * 1024,
    timeout: 60_000,
  })
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function cliJson(args, env = {}) {
  const result = runCli(args, env)
  let payload
  try {
    payload = JSON.parse(result.stdout)
  } catch {
    throw new Error(`CLI 输出不是 JSON（code=${result.code}）:\nstdout=${result.stdout}\nstderr=${result.stderr}`)
  }
  return { ...result, payload }
}

// ── 确定性随机 ───────────────────────────────────────────────────────────────
function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const CJK_CHARS = [...'记忆插件用户偏好时区会话任务提醒权限模型成本测试报错部署文档项目搜索历史版本验收标准先结论后证据端到端同步索引取代审计上下文预算门槛召回分词语义向量数据库磁盘格式兼容幂等墓碑双时态重要度衰减半衰期']
const ASCII_WORDS = ['memory', 'recall', 'token', 'budget', 'deploy', 'install', 'node', 'v24.14.0', '200', '8443',
  'the', 'is', 'not', 'D:\\2006L\\apps', 'café', 'naïve', 'MCP', 'FTS5', 'Q4_K_M', '0.55', 'memory.mjs']
const EMOJI = ['😀', '🧠', '🔥', '👍🏽', '🀄', '→', '≥', '×', 'ª']
const PUNCT = ['，', '。', '！', '？', '；', '：', '、', '（', '）', '【', '】', '《', '》',
  ',', '.', '!', '?', ';', ':', '(', ')', '[', ']', '{', '}', '"', "'", '-', '_', '/', '\\', '|', '~', '`']
const SPACES = [' ', '  ', '\t', '\n', '\u00a0', '\u3000']

function buildCorpus() {
  const rand = mulberry32(0x5eed)
  const pick = (list) => list[Math.floor(rand() * list.length)]
  const build = (n, pool) => Array.from({ length: n }, () => pick(pool)).join('')
  const texts = ['', ' ', '\n', '\t', '0', '1234567890', 'v24.14.0', '2026-11-01T22:37:07+08:00', '0.55']
  for (let i = 0; i < 25; i += 1) texts.push(build(1 + Math.floor(rand() * 40), CJK_CHARS))
  for (let i = 0; i < 20; i += 1) texts.push(Array.from({ length: 1 + Math.floor(rand() * 10) }, () => pick(ASCII_WORDS)).join(' '))
  for (let i = 0; i < 25; i += 1) {
    texts.push(Array.from({ length: 2 + Math.floor(rand() * 12) }, () => pick([...CJK_CHARS, ...ASCII_WORDS, ...PUNCT, ...EMOJI, ...SPACES])).join(''))
  }
  for (let i = 0; i < 15; i += 1) texts.push(build(1 + Math.floor(rand() * 8), [...EMOJI, ...CJK_CHARS, ...ASCII_WORDS]))
  for (let i = 0; i < 10; i += 1) texts.push(build(1 + Math.floor(rand() * 12), PUNCT))
  for (let i = 0; i < 10; i += 1) texts.push(build(1 + Math.floor(rand() * 10), SPACES))
  for (let i = 0; i < 10; i += 1) texts.push(`${'长'.repeat(150 + Math.floor(rand() * 250))}${pick(ASCII_WORDS)}`)
  for (let i = 0; i < 6; i += 1) texts.push(String(Math.floor(rand() * 1e12)))
  for (let i = 0; i < 6; i += 1) texts.push(`v${Math.floor(rand() * 10)}.${Math.floor(rand() * 20)}.${Math.floor(rand() * 20)}`)
  while (texts.length < 240) {
    texts.push(Array.from({ length: 1 + Math.floor(rand() * 24) }, () => pick([...CJK_CHARS, ...ASCII_WORDS, ...PUNCT, ...EMOJI])).join(''))
  }
  return texts.slice(0, 240)
}

const CORPUS = buildCorpus()
const NOW = 1_800_000_000_000

function buildRandomEntries() {
  const rand = mulberry32(0xbeef)
  const pick = (list) => list[Math.floor(rand() * list.length)]
  const texts = CORPUS.filter((text) => text.trim().length > 0)
  const kinds = ['fact', 'preference', 'event', 'task', 'person']
  return Array.from({ length: 50 }, (_, index) => {
    const entry = {
      id: `e${String(index).padStart(2, '0')}`,
      kind: pick(kinds),
      text: texts[(index * 7) % texts.length],
      tags: rand() < 0.5 ? [] : [pick(['部署', '沟通', '记忆', '测试', '视频', 'memory', 'skill'])],
      confidence: pick([0, 1, 2]),
      updatedAt: NOW - Math.floor(rand() * 200 * 24 * 3600 * 1000),
    }
    if (rand() < 0.5) entry.importance = Math.round(rand() * 100) / 100
    if (index % 17 === 0) entry.validUntil = NOW - 24 * 3600 * 1000
    return entry
  })
}

const RANDOM_ENTRIES = buildRandomEntries()

function buildRandomQueries() {
  const queries = []
  for (let i = 0; i < 12; i += 1) {
    const text = RANDOM_ENTRIES[(i * 5) % RANDOM_ENTRIES.length].text
    queries.push(text.slice(0, Math.max(2, Math.min(12, text.length))).trim() || 'memory')
  }
  queries.push('部署端口是多少', '记忆层级与预算', 'the memory recall token', '版本号 v24.14.0',
    '完全不相关的话题：晚饭吃什么', '测试报告', '用户偏好', '端口 8443')
  return queries.slice(0, 20)
}

const RANDOM_QUERIES = buildRandomQueries()
const SCORE_OPTIONS = [
  { k: 3, budgetTokens: 300 },
  { k: 8, budgetTokens: 800 },
  { k: 3, budgetTokens: 300, minConfidence: 1 },
]

// ── 插件原实现加载 ───────────────────────────────────────────────────────────
const PLUGIN_DIR = process.env.PA_PLUGIN_DIR || join(PROJECT, '..', 'plugins', 'personal-agent')
const PLUGIN_AVAILABLE = existsSync(join(PLUGIN_DIR, 'lib', 'recall.js'))
const SKIP_PLUGIN = PLUGIN_AVAILABLE ? false : `未找到插件源码：${PLUGIN_DIR}（差分项跳过）`
let pluginCache = null
async function pluginModules() {
  if (!PLUGIN_AVAILABLE) return null
  if (!pluginCache) {
    pluginCache = {
      recall: await import(pathToFileURL(join(PLUGIN_DIR, 'lib', 'recall.js')).href),
      store: await import(pathToFileURL(join(PLUGIN_DIR, 'lib', 'store.js')).href),
    }
  }
  return pluginCache
}

// ── 真实记忆库（只读） ───────────────────────────────────────────────────────
const REAL = process.env.PA_REAL_STORE || join(homedir(), '.dsh', 'storages', 'personal-agent')
const REAL_AVAILABLE = existsSync(join(REAL, 'entries'))
const SKIP_REAL = REAL_AVAILABLE ? false : `未找到真实记忆库：${REAL}`

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function hashTree(root) {
  const rows = []
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const rel = prefix ? `${prefix}/${name}` : name
      if (statSync(full).isDirectory()) walk(full, rel)
      else rows.push(`${sha256(readFileSync(full))}  ${rel}`)
    }
  }
  walk(root, '')
  return rows.sort()
}

const REAL_SNAPSHOT_BEFORE = REAL_AVAILABLE ? hashTree(REAL) : []

function readJsonl(file) {
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

let migrationFixtureCache = null
function migrationFixture() {
  if (migrationFixtureCache) return migrationFixtureCache
  const dir = tempDir('migrate-')
  const export1 = join(dir, 'export1.jsonl')
  const exported = runCli(['--root', REAL, 'export', '--out', export1])
  assert.equal(exported.code, 0, `对真实库 export 失败：${exported.stderr}`)
  const store = join(dir, 'newstore')
  const imported = runCli(['--root', store, 'import', export1])
  assert.equal(imported.code, 0, `import 失败：${imported.stderr}`)
  const export2 = join(dir, 'export2.jsonl')
  assert.equal(runCli(['--root', store, 'export', '--out', export2]).code, 0)
  migrationFixtureCache = {
    dir,
    store,
    // export 文件里可能带一行 profile（`{__profile__:{…}}`），它不属于条目
    records1: readJsonl(export1).filter((record) => !record.__profile__),
    records2: readJsonl(export2).filter((record) => !record.__profile__),
    profiles: cliJson(['--root', store, 'profile', 'get']).payload,
  }
  return migrationFixtureCache
}

const MIGRATION_FIELDS = ['kind', 'text', 'tags', 'confidence', 'importance', 'subject', 'sourceSessionId',
  'createdAt', 'validFrom', 'validUntil', 'supersedes', 'supersededBy']

function entryFieldDiff(recordsA, recordsB, ignore = ['updatedAt']) {
  const byId = new Map(recordsB.map((record) => [record.id, record]))
  const diffs = []
  for (const a of recordsA) {
    const b = byId.get(a.id)
    if (!b) { diffs.push(`${a.id}: 目标库缺失`); continue }
    for (const field of MIGRATION_FIELDS) {
      if (ignore.includes(field)) continue
      if (JSON.stringify(a[field]) !== JSON.stringify(b[field])) {
        diffs.push(`${a.id}.${field}: ${JSON.stringify(a[field])} → ${JSON.stringify(b[field])}`)
      }
    }
  }
  return diffs
}

// ═════════════════════════════════════════════════════════════════════════════
// A. 保真：与插件原实现差分
// ═════════════════════════════════════════════════════════════════════════════

test('A1 随机语料差分：tokenize 240 条逐条一致', { skip: SKIP_PLUGIN }, async () => {
  const { recall: theirs } = await pluginModules()
  assert.equal(CORPUS.length, 240)
  CORPUS.forEach((text, index) => {
    assert.deepEqual(portRecall.tokenize(text), theirs.tokenize(text), `tokenize 不一致 #${index} ${JSON.stringify(text)}`)
  })
})

test('A1 随机语料差分：estimateTokens 240 条一致', { skip: SKIP_PLUGIN }, async () => {
  const { recall: theirs } = await pluginModules()
  CORPUS.forEach((text, index) => {
    assert.equal(portRecall.estimateTokens(text), theirs.estimateTokens(text), `estimateTokens 不一致 #${index}`)
  })
})

test('A1 随机语料差分：expandWeights（排序后 entries）240 条一致', { skip: SKIP_PLUGIN }, async () => {
  const { recall: theirs } = await pluginModules()
  CORPUS.forEach((text, index) => {
    const mine = [...portRecall.expandWeights(text).entries()].sort()
    const other = [...theirs.expandWeights(text).entries()].sort()
    assert.deepEqual(mine, other, `expandWeights 不一致 #${index} ${JSON.stringify(text)}`)
  })
})

test('A1 随机条目差分：defaultImportance 逐项一致', { skip: SKIP_PLUGIN }, async () => {
  const { recall: theirs } = await pluginModules()
  const rand = mulberry32(0xd00d)
  const pick = (list) => list[Math.floor(rand() * list.length)]
  for (let i = 0; i < 300; i += 1) {
    const entry = {
      kind: pick(['fact', 'preference', 'event', 'task', 'person', 'unknown', undefined]),
      tags: pick([undefined, [], ['a'], ['a', 'b']]),
      confidence: pick([undefined, 0, 1, 2, 5]),
    }
    assert.equal(portRecall.defaultImportance(entry), theirs.defaultImportance(entry), `defaultImportance ${JSON.stringify(entry)}`)
  }
})

test('A1 随机条目差分：decayOf 逐项一致（含未来时间/缺时间戳）', { skip: SKIP_PLUGIN }, async () => {
  const { recall: theirs } = await pluginModules()
  const rand = mulberry32(0xface)
  const pick = (list) => list[Math.floor(rand() * list.length)]
  for (let i = 0; i < 300; i += 1) {
    const now = NOW + Math.floor(rand() * 1e9)
    const entry = {
      kind: pick(['fact', 'preference', 'event', 'task', 'person', 'unknown', undefined]),
      updatedAt: rand() < 0.8 ? now - Math.floor(rand() * 400 * 24 * 3600 * 1000) : undefined,
      createdAt: rand() < 0.8 ? now - Math.floor(rand() * 400 * 24 * 3600 * 1000) : undefined,
    }
    assert.equal(portRecall.decayOf(entry, now), theirs.decayOf(entry, now), `decayOf ${JSON.stringify(entry)}`)
  }
})

test('A2 随机召回差分：50 条目 × 20 查询 × 3 组参数，id 序列与分数一致', { skip: SKIP_PLUGIN }, async () => {
  const { recall: theirs } = await pluginModules()
  let comparedHits = 0
  for (const query of RANDOM_QUERIES) {
    for (const options of SCORE_OPTIONS) {
      const mine = portRecall.recall(RANDOM_ENTRIES, query, { ...options, now: NOW })
      const other = theirs.recall(RANDOM_ENTRIES, query, { ...options, now: NOW })
      assert.deepEqual(mine.map((hit) => hit.entry.id), other.map((hit) => hit.entry.id),
        `选中 id 序列不一致 query=${JSON.stringify(query)} options=${JSON.stringify(options)}`)
      mine.forEach((hit, index) => {
        assert.ok(Math.abs(hit.score - other[index].score) < 1e-12,
          `score 差 >=1e-12 query=${JSON.stringify(query)} #${index} ${hit.score} vs ${other[index].score}`)
      })
      assert.equal(portRecall.renderRecallBlock(mine), theirs.renderRecallBlock(other), `注入块不一致 query=${JSON.stringify(query)}`)
      comparedHits += mine.length
    }
  }
  assert.ok(comparedHits > 0, '随机召回差分没有产生任何命中，用例无效')
})

test('A3 随机写序列差分：40 步 put 的 id/created/superseded 与最终状态一致', { skip: SKIP_PLUGIN }, async () => {
  const { store: pluginStore } = await pluginModules()
  const rand = mulberry32(0xa3a3)
  const pick = (list) => list[Math.floor(rand() * list.length)]
  const bases = [
    '部署脚本放在 D 盘目录并按天备份，日志按周归档一次',
    '验收标准：所有结论必须可验证并且附上命令回执',
    '用户偏好先结论后证据，给数字和路径，不要形容词',
    '时区按 Asia/Shanghai 理解今天的日期与明天',
    '像素猫视频日更每天三条，QA 不过不发',
  ]
  const tagsPool = ['部署', '验收', '沟通', '视频', '测试', '环境']
  const subjects = ['验收标准', '时区', '沟通风格', undefined]
  const mutate = (text) => {
    const variants = [text, text.replace('每天', '每周'), text.replace('按天', '按周'), `${text}（补充：2026-11 变更）`, text.slice(0, Math.max(6, text.length - 4))]
    return pick(variants)
  }

  const rootMine = tempDir('put-port-')
  const rootTheirs = tempDir('put-plugin-')
  try {
    const mine = portStore.openStore({ root: rootMine })
    const theirs = pluginStore.openStore({ root: rootTheirs })
    for (let step = 0; step < 40; step += 1) {
      const op = {
        kind: pick(['fact', 'preference', 'event', 'task', 'person']),
        text: mutate(pick(bases)),
        tags: rand() < 0.5 ? undefined : [pick(tagsPool), pick(tagsPool)],
        subject: pick(subjects),
        confidence: rand() < 0.5 ? undefined : pick([0, 1, 2]),
      }
      if (rand() < 0.4) op.importance = Math.round(rand() * 100) / 100
      const a = mine.put(op)
      const b = theirs.put(op)
      assert.equal(a.record.id, b.record.id, `step ${step} id 不一致 ${JSON.stringify(op)}`)
      assert.equal(a.created, b.created, `step ${step} created 不一致`)
      assert.equal(a.superseded ?? null, b.superseded ?? null, `step ${step} superseded 不一致 ${JSON.stringify(op)}`)
    }
    const strip = (store) => store.list({ includeInactive: true }).map((entry) => {
      const { createdAt, updatedAt, validFrom, validUntil, ...rest } = entry
      return rest
    }).sort((a, b) => String(a.id).localeCompare(String(b.id)))
    assert.deepEqual(strip(mine), strip(theirs), '最终 includeInactive 列表（去时间戳）不一致')
    const statKey = (stats) => ({ active: stats.active, superseded: stats.superseded, total: stats.total, byKind: stats.byKind })
    assert.deepEqual(statKey(mine.stats()), statKey(theirs.stats()), 'stats 不一致')
    assert.deepEqual(readdirSync(join(rootMine, 'entries')).sort(), readdirSync(join(rootTheirs, 'entries')).sort(), '落盘文件集不一致')
  } finally {
    rmSync(rootMine, { recursive: true, force: true })
    rmSync(rootTheirs, { recursive: true, force: true })
  }
})

test('A4 迁移保真：真实库 export→import 后 id 集合一致', { skip: SKIP_REAL }, () => {
  const { records1, records2 } = migrationFixture()
  assert.ok(records1.length >= 1, '真实库导出为空')
  assert.deepEqual(records2.map((record) => record.id).sort(), records1.map((record) => record.id).sort())
})

test('A4 事实：export 含活动+历史条目，但不含墓碑（删除记录不迁移）', { skip: SKIP_REAL }, () => {
  const { records1 } = migrationFixture()
  const entryFiles = readdirSync(join(REAL, 'entries')).filter((name) => name.endsWith('.json'))
  const tombstones = entryFiles.map((name) => {
    try {
      const record = JSON.parse(readFileSync(join(REAL, 'entries', name), 'utf8'))
      return record && record.deleted === true ? record.id : null
    } catch {
      return null
    }
  }).filter(Boolean)
  assert.ok(tombstones.length > 0, '真实库没有墓碑，本条事实无法验证')
  assert.equal(records1.length + tombstones.length, entryFiles.length,
    `export 记录数 ${records1.length} + 墓碑 ${tombstones.length} 应等于条目文件数 ${entryFiles.length}`)
  const exportedIds = new Set(records1.map((record) => record.id))
  for (const id of tombstones) assert.ok(!exportedIds.has(id), `墓碑 ${id} 出现在 export 里`)
})

test('A4b 真实语料差分：54 条真实条目的 tokenize/expandWeights 与插件一致', { skip: SKIP_PLUGIN || SKIP_REAL }, async () => {
  const { recall: theirs } = await pluginModules()
  const { records1 } = migrationFixture()
  for (const record of records1) {
    assert.deepEqual(portRecall.tokenize(record.text), theirs.tokenize(record.text), `tokenize 不一致 ${record.id}`)
    assert.deepEqual([...portRecall.expandWeights(record.text).entries()].sort(),
      [...theirs.expandWeights(record.text).entries()].sort(), `expandWeights 不一致 ${record.id}`)
  }
})

test('A4b 真实语料差分：真实条目上 20 查询 × 3 组参数的召回一致', { skip: SKIP_PLUGIN || SKIP_REAL }, async () => {
  const { recall: theirs } = await pluginModules()
  const { records1 } = migrationFixture()
  const queries = records1.slice(0, 10).map((record) => record.text.slice(0, 10))
    .concat(['部署', '记忆 预算', 'tailscale 通道', '视频 去AI味', '台式机 GPU', 'C盘空间',
      '报告类文件', '插件重载', '手机 SSH', '完全无关：晚饭'])
  const now = Date.now()
  let comparedHits = 0
  for (const query of queries) {
    for (const options of SCORE_OPTIONS) {
      const mine = portRecall.recall(records1, query, { ...options, now })
      const other = theirs.recall(records1, query, { ...options, now })
      assert.deepEqual(mine.map((hit) => hit.entry.id), other.map((hit) => hit.entry.id),
        `真实语料召回不一致 query=${JSON.stringify(query)} options=${JSON.stringify(options)}`)
      mine.forEach((hit, index) => assert.ok(Math.abs(hit.score - other[index].score) < 1e-12,
        `真实语料 score 差 >=1e-12 query=${JSON.stringify(query)} #${index}`))
      comparedHits += mine.length
    }
  }
  assert.ok(comparedHits > 0, '真实语料召回差分没有产生命中')
})

// ── 迁移契约（当前预期失败：import 只回放 text/kind/tags/confidence/importance/subject/sourceSessionId） ──
test('契约✗ A4：迁移必须保留 createdAt/validFrom（除 updatedAt 外字段保真）', { skip: SKIP_REAL }, () => {
  const { records1, records2 } = migrationFixture()
  const diffs = entryFieldDiff(records1, records2, ['updatedAt', 'validUntil', 'supersedes', 'supersededBy'])
  assert.equal(diffs.length, 0, `${diffs.length} 条记录的时间字段被重置，例：\n${diffs.slice(0, 3).join('\n')}`)
})

test('契约✗ A4：迁移必须保留 validUntil/supersedes/supersededBy（历史不被复活、当前值不被旧值改写）', { skip: SKIP_REAL }, () => {
  const { records1, records2 } = migrationFixture()
  const diffs = entryFieldDiff(records1, records2, ['updatedAt', 'createdAt', 'validFrom'])
  assert.equal(diffs.length, 0, `${diffs.length} 处治理字段被改写，例：\n${diffs.slice(0, 4).join('\n')}`)
})

test('契约✗ A4：迁移后「活动条目 id 集合」必须与源库一致', { skip: SKIP_REAL }, () => {
  const { records1, records2 } = migrationFixture()
  const active = (records) => new Set(records.filter((record) => !record.validUntil).map((record) => record.id))
  const source = active(records1)
  const target = active(records2)
  const lost = [...source].filter((id) => !target.has(id))
  const revived = [...target].filter((id) => !source.has(id))
  assert.deepEqual({ 源库活动却在新库失效: lost, 源库失效却在新库活动: revived }, { 源库活动却在新库失效: [], 源库失效却在新库活动: [] },
    `迁移改写了「哪条是当前真相」：失效 ${lost.length} 条、复活 ${revived.length} 条`)
})

test('契约✗ A4：迁移必须保留 profile（timezone/locale/notes 等）', { skip: SKIP_REAL }, () => {
  const { profiles } = migrationFixture()
  const source = JSON.parse(readFileSync(join(REAL, 'profile.json'), 'utf8'))
  const pick = (profile) => ({
    name: profile.name,
    timezone: profile.timezone,
    locale: profile.locale,
    preferences: profile.preferences,
    notes: profile.notes,
  })
  assert.deepEqual(pick(profiles), pick(source), `import 后 profile=${JSON.stringify(profiles)}`)
})

test('契约✗ A4：二次 export 必须与首次 export 在字段上一致（除 updatedAt）', { skip: SKIP_REAL }, () => {
  const { records1, records2 } = migrationFixture()
  const diffs = entryFieldDiff(records1, records2, ['updatedAt'])
  assert.equal(diffs.length, 0, `${diffs.length} 处字段差异，例：\n${diffs.slice(0, 4).join('\n')}`)
})

// ═════════════════════════════════════════════════════════════════════════════
// B. 真实数据安全（只读）
// ═════════════════════════════════════════════════════════════════════════════
test('B5 真实库只读：本套件执行前后全文件 SHA256 完全一致', { skip: SKIP_REAL }, () => {
  const after = hashTree(REAL)
  assert.deepEqual(after, REAL_SNAPSHOT_BEFORE, '真实记忆库在测试执行期间被修改')
  assert.ok(after.length > 0)
})

// ═════════════════════════════════════════════════════════════════════════════
// C. 边界与破坏性场景（全部在临时库）
// ═════════════════════════════════════════════════════════════════════════════

test('C8 空库：doctor/inject/recall/list/stats/export 不崩且输出符合预期', () => {
  const root = tempDir('empty-')
  try {
    const doctor = runCli(['--root', root, 'doctor'])
    assert.equal(doctor.code, 0, doctor.stderr)
    assert.match(doctor.stdout, /可用/)

    const inject = runCli(['--root', root, 'inject', '任何查询'])
    assert.equal(inject.code, 0)
    assert.equal(inject.stdout, '', '空库 inject 必须零输出')

    const recall = runCli(['--root', root, 'recall', '任何查询'])
    assert.equal(recall.code, 0)
    assert.match(recall.stdout, /没有匹配的记忆/)

    const list = runCli(['--root', root, 'list'])
    assert.equal(list.code, 0)
    assert.match(list.stdout, /记忆库为空/)

    const stats = cliJson(['--root', root, '--json', 'stats']).payload
    assert.equal(stats.active, 0)
    assert.equal(stats.superseded, 0)
    assert.equal(stats.total, 0)

    const exported = runCli(['--root', root, 'export'])
    assert.equal(exported.code, 0)
    assert.equal(exported.stdout, '', '空库 export 必须零输出且不崩')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function corruptStoreFixture() {
  const root = tempDir('corrupt-')
  assert.equal(runCli(['--root', root, 'remember', '部署在 D 盘端口 8443', '--tags', '部署']).code, 0)
  const entriesDir = join(root, 'entries')
  writeFileSync(join(entriesDir, 'bad-unparseable.json'), '{ not json', 'utf8')
  writeFileSync(join(entriesDir, 'bad-invalid-record.json'), '{"id":1}', 'utf8')
  writeFileSync(join(entriesDir, 'bad-2mb.json'), 'A'.repeat(2 * 1024 * 1024), 'utf8')
  return root
}

test('C9 损坏条目：其他条目仍可用、recall/list/doctor 不崩', () => {
  const root = corruptStoreFixture()
  try {
    const doctor = runCli(['--root', root, 'doctor'])
    assert.equal(doctor.code, 0, doctor.stderr)
    assert.match(doctor.stdout, /活动 1/)
    const recalled = cliJson(['--root', root, '--json', 'recall', '部署端口']).payload
    assert.equal(recalled.count, 1, '损坏文件不应影响正常条目召回')
    assert.equal(recalled.hits[0].id, portStore.entryId('fact', '部署在 D 盘端口 8443'))
    const listed = cliJson(['--root', root, '--json', 'list']).payload
    assert.equal(listed.entries.length, 1)
    const stats = cliJson(['--root', root, '--json', 'stats']).payload
    assert.equal(stats.total, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('契约✗ C9：doctor 的 corrupt 计数必须覆盖所有无法加载的条目文件（3 个）', () => {
  const root = corruptStoreFixture()
  try {
    const doctor = cliJson(['--root', root, '--json', 'doctor'])
    assert.equal(doctor.payload.corrupt, 3,
      `doctor 只报了 ${doctor.payload.corrupt} 个损坏文件；其中 { not json 与 2MB 垃圾文件既不是条目也不是墓碑，被静默忽略`)
    const stats = cliJson(['--root', root, '--json', 'stats']).payload
    assert.equal(stats.corrupt, 3, `stats.corrupt=${stats.corrupt}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('C10 环境错误：--root Z:\\nope（不存在的盘符）退出码 2 且报错可读', () => {
  const result = runCli(['--root', 'Z:\\nope', 'doctor'])
  assert.equal(result.code, 2, `期望 2，实测 ${result.code}；stderr=${result.stderr}`)
  assert.match(result.stderr, /打不开记忆库/)
  assert.match(result.stderr, /Z:\\nope/)
  assert.doesNotMatch(result.stderr, /\n\s+at /, '不应输出调用栈')
  assert.equal(result.stdout, '')
})

test('C11 超大文本：>200 字被拒（退出码 1、提示当前字数、不落盘、不静默截断）', () => {
  const root = tempDir('oversize-')
  try {
    const tooLong = runCli(['--root', root, 'remember', '记'.repeat(201)])
    assert.equal(tooLong.code, 1, `期望 1，实测 ${tooLong.code}；stderr=${tooLong.stderr}`)
    assert.match(tooLong.stderr, /200/)
    assert.match(tooLong.stderr, /当前 201/)
    let stats = cliJson(['--root', root, '--json', 'stats']).payload
    assert.equal(stats.active, 0, '超长文本不应落盘')

    const boundary = runCli(['--root', root, 'remember', '记'.repeat(200)])
    assert.equal(boundary.code, 0, boundary.stderr)
    stats = cliJson(['--root', root, '--json', 'stats']).payload
    assert.equal(stats.active, 1)
    const listed = cliJson(['--root', root, '--json', 'list']).payload
    assert.equal(listed.entries[0].text.length, 200, '200 字必须原样保存（不截断）')

    const way = runCli(['--root', root, 'remember', '记'.repeat(250)])
    assert.equal(way.code, 1)
    assert.match(way.stderr, /当前 250/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('C12 --root 优先级：flag > PA_MEMORY_ROOT > DSH_HOME > 用户目录（纯函数，不写盘）', () => {
  const base = tempDir('rootprio-')
  try {
    const flag = join(base, 'flag')
    const pa = join(base, 'pa')
    const dsh = join(base, 'dsh')
    const home = join(base, 'home')
    assert.equal(resolveRoot({ flag, env: { PA_MEMORY_ROOT: pa, DSH_HOME: dsh, USERPROFILE: home }, cwd: base }).root, resolve(flag))
    assert.equal(resolveRoot({ env: { PA_MEMORY_ROOT: pa, DSH_HOME: dsh, USERPROFILE: home }, cwd: base }).root, resolve(pa))
    assert.equal(resolveRoot({ env: { DSH_HOME: dsh, USERPROFILE: home }, cwd: base }).root, join(dsh, 'storages', 'personal-agent'))
    assert.equal(resolveRoot({ env: { USERPROFILE: home }, cwd: base }).root, join(home, '.dsh', 'storages', 'personal-agent'))
    assert.equal(resolveRoot({ flag: undefined, env: {}, cwd: join(base, 'profiles', 'desktop') }).root,
      join(base, 'profiles', 'desktop', '..', '..', 'storages', 'personal-agent'))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('C12 CLI 实测：--root 覆盖 PA_MEMORY_ROOT/DSH_HOME；环境变量按优先级生效', () => {
  const base = tempDir('rootcli-')
  try {
    const flag = join(base, 'flag')
    const pa = join(base, 'pa')
    const dsh = join(base, 'dsh')
    const env = { PA_MEMORY_ROOT: pa, DSH_HOME: dsh }
    const byFlag = cliJson(['--root', flag, '--json', 'stats'], env).payload
    assert.equal(resolve(byFlag.root), resolve(flag))
    const byPa = cliJson(['--json', 'stats'], env).payload
    assert.equal(resolve(byPa.root), resolve(pa))
    const byDsh = cliJson(['--json', 'stats'], { DSH_HOME: dsh }).payload
    assert.equal(resolve(byDsh.root), resolve(join(dsh, 'storages', 'personal-agent')))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('C13 幂等：同文本写两次条目数不变、createdAt 不变', () => {
  const root = tempDir('idem-')
  try {
    const first = cliJson(['--root', root, '--json', 'remember', '部署在 D 盘端口 8443', '--tags', '部署']).payload
    const second = cliJson(['--root', root, '--json', 'remember', '部署在 D 盘端口 8443', '--tags', '部署']).payload
    assert.equal(first.created, true)
    assert.equal(second.created, false)
    assert.equal(second.id, first.id)
    assert.equal(second.createdAt, first.createdAt, 'createdAt 必须保留')
    assert.equal(cliJson(['--root', root, '--json', 'stats']).payload.active, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('C13 import --dry-run 不落盘', () => {
  const base = tempDir('dryrun-')
  try {
    const file = join(base, 'payload.jsonl')
    writeFileSync(file, `${JSON.stringify({ kind: 'fact', text: 'dry-run 测试条目', tags: ['测试'], confidence: 1 })}\n`, 'utf8')
    const store = join(base, 'store')
    const dry = cliJson(['--root', store, 'import', file, '--dry-run', '--json']).payload
    assert.equal(dry.dryRun, true)
    assert.equal(dry.created, 1)
    assert.deepEqual(readdirSync(join(store, 'entries')), [], '--dry-run 不得写入任何条目文件')
    assert.equal(cliJson(['--root', store, '--json', 'stats']).payload.total, 0)
    const real = cliJson(['--root', store, 'import', file, '--json']).payload
    assert.equal(real.created, 1)
    assert.equal(cliJson(['--root', store, '--json', 'stats']).payload.active, 1)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('C14 退出码：用法错误=1、环境/IO 错误=2', () => {
  const root = tempDir('exit-')
  try {
    const usageCases = [
      ['--root', root, 'remember'],
      ['--root', root, 'nonsense'],
      ['--root', root, '--bogus-flag', 'stats'],
      ['--root', root, 'show'],
      ['--root', root, 'profile', 'set', 'badpair'],
      ['--root', root, 'recall', 'x', '--k', 'abc'],
    ]
    for (const args of usageCases) {
      const result = runCli(args)
      assert.equal(result.code, 1, `用法错误应为 1，实测 ${result.code}：${args.join(' ')}\n${result.stderr}`)
      assert.ok(result.stderr.length > 0, `用法错误应有 stderr：${args.join(' ')}`)
    }
    const envCases = [
      ['--root', 'Z:\\nope', 'doctor'],
      ['--root', root, 'import', join(root, 'no-such-file.jsonl')],
      ['--root', root, 'export', '--out', 'Z:\\nope\\x.jsonl'],
    ]
    for (const args of envCases) {
      const result = runCli(args)
      assert.equal(result.code, 2, `环境/IO 错误应为 2，实测 ${result.code}：${args.join(' ')}\n${result.stderr}`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── 额外行为事实（用于报告 D 段「最易误解」） ─────────────────────────────────

test('D-事实：inject 只注入 confidence>=1；recall 能看到 confidence=0', () => {
  const root = tempDir('conf-')
  try {
    const store = portStore.openStore({ root })
    store.put({ kind: 'fact', text: '部署端口 8443 待确认', confidence: 0, tags: ['部署'] })
    store.put({ kind: 'fact', text: '部署端口 9000 已确认', confidence: 2, tags: ['部署'] })
    const inject = cliJson(['--root', root, '--json', 'inject', '部署端口']).payload
    assert.equal(inject.count, 1)
    assert.equal(inject.ids[0], portStore.entryId('fact', '部署端口 9000 已确认'))
    const recall = cliJson(['--root', root, '--json', 'recall', '部署端口']).payload
    assert.equal(recall.count, 2)
    assert.ok(recall.block.includes('（待确认）'), 'recall 块应标出待确认条目')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('D-事实：inject 整块 token 估算 <= --budget（CLI 兜底），默认 k<=3', () => {
  const root = tempDir('injectbudget-')
  try {
    const store = portStore.openStore({ root })
    // 3 条 128 字符的命中行：每行估算 80 tokens，三行 240（<300-48），但整块因 wrapper+closing 会到 304 → 必须触发兜底。
    for (let i = 0; i < 3; i += 1) {
      store.put({
        kind: 'fact',
        confidence: 2,
        text: `部署端口 8443 ${String.fromCharCode(0x4e00 + i).repeat(92)}`,
      })
    }
    for (const budget of [80, 150, 300, 400]) {
      const result = cliJson(['--root', root, '--json', 'inject', '部署端口 8443', '--budget', String(budget)])
      assert.ok(result.payload.tokens <= budget, `budget=${budget} 实际 tokens=${result.payload.tokens}`)
      assert.ok(result.payload.count <= 3, 'inject 默认 k=3')
      if (result.payload.count > 0) assert.match(result.payload.block, /\[mem:/)
    }
    const at300 = cliJson(['--root', root, '--json', 'inject', '部署端口 8443']).payload
    assert.ok(at300.tokens <= 300, `默认注入整块 ${at300.tokens} tokens > 300`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('D-事实：list 的 20 条硬上限（--all/--limit 100 也不能列全）', () => {
  const root = tempDir('listcap-')
  try {
    const store = portStore.openStore({ root })
    // 每条用互不相同的 ASCII token，避免 Jaccard>=0.55 触发取代，保证 active=25。
    for (let i = 0; i < 25; i += 1) {
      store.put({ kind: 'fact', text: `测试条目 alpha${i} bravo${i} charlie${i} delta${i} echo${i} foxtrot${i}` })
    }
    const limited = cliJson(['--root', root, '--json', 'list', '--limit', '100', '--all']).payload
    assert.equal(limited.total, 25)
    assert.equal(limited.entries.length, 20, 'list 的 --limit 被 MAX_LIST=20 静默夹取')
    const text = runCli(['--root', root, 'list', '--all'])
    assert.match(text.stdout, /活动 25 条/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('D-事实：非法 --confidence/--importance 被静默替换/夹取（不报错）', () => {
  const root = tempDir('clamp-')
  try {
    const badConfidence = cliJson(['--root', root, '--json', 'remember', '非法置信度测试', '--confidence', '9', '--importance', '5']).payload
    assert.equal(badConfidence.confidence, 1, '非法 confidence 静默回退为 1')
    assert.equal(badConfidence.importance, 1, 'importance 被 clamp 到 1')
    const negative = cliJson(['--root', root, '--json', 'remember', '负重要度测试', '--importance', '-3']).payload
    assert.equal(negative.importance, 0, 'importance 被 clamp 到 0')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
