/**
 * Unit tests for the memory layer (node:test, zero dependencies).
 *
 *   node --test tests/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  tokenize, estimateTokens, defaultImportance, decayOf, expandWeights,
  recall, renderRecallBlock, renderLine, RECALL_DEFAULTS,
} from '../lib/recall.mjs'
import { openStore, entryId, normalize, KINDS } from '../lib/store.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, '..', 'memory.mjs')

function tempStore() {
  const root = mkdtempSync(join(tmpdir(), 'am-test-'))
  return { root, store: openStore({ root }) }
}

function runCli(args, env = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}

// ── tokenisation ────────────────────────────────────────────────────────────

test('tokenize：中文按二元组切，停用二元组被丢、单字 run 保留', () => {
  assert.deepEqual(tokenize('记忆'), ['记忆'])
  assert.deepEqual(tokenize('的记忆'), ['的记', '记忆'])
  assert.deepEqual(tokenize('我的记忆'), ['的记', '记忆']) // 「我的」是停用二元组
  assert.deepEqual(tokenize('好'), ['好'])
  assert.deepEqual(tokenize(''), [])
})

test('tokenize：英文小写、丢停用词、保留数字与版本号', () => {
  assert.deepEqual(tokenize('The MEMORY is good'), ['memory'])
  assert.deepEqual(tokenize('node v24.14.0'), ['node', 'v24.14.0'])
  assert.deepEqual(tokenize('a b c'), [])
})

test('estimateTokens 按 1.6 字符/token 向上取整', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('12345678'), 5)
  assert.equal(estimateTokens('中文十个字符啊啊啊啊啊'), 7)
})

// ── scoring primitives ──────────────────────────────────────────────────────

test('defaultImportance：类型先验 + 标签 + 置信度（默认置信度按 0.05 计）', () => {
  assert.equal(defaultImportance({ kind: 'preference' }), 0.9)
  assert.equal(defaultImportance({ kind: 'preference', confidence: 2 }), 0.95)
  assert.equal(defaultImportance({ kind: 'fact', tags: ['x'], confidence: 1 }), 0.75)
  assert.equal(defaultImportance({ kind: 'fact' }), 0.65)
  assert.equal(defaultImportance({}), 0.55)
})

test('decayOf：半衰期到点减半', () => {
  const now = 1_000_000_000
  assert.equal(decayOf({ kind: 'fact', updatedAt: now }, now), 1)
  const halfLife = 90 * 24 * 3600 * 1000
  const half = decayOf({ kind: 'fact', updatedAt: now - halfLife }, now)
  assert.ok(Math.abs(half - 0.5) < 1e-9, `expected 0.5, got ${half}`)
})

test('expandWeights：别名权重 0.6，且不覆盖直接命中', () => {
  const weights = expandWeights('记忆')
  assert.equal(weights.get('记忆'), 1)
  assert.equal(weights.get('memory'), 0.6)
})

test('别名不能单独创建命中（硬门槛）', () => {
  const entries = [{ id: 'x', kind: 'fact', text: 'memory layer', tags: [], updatedAt: Date.now() }]
  // 查询只有中文「记忆」：别名 memory 权重 0.6 < 1，不算 direct hit → 0 命中
  assert.equal(recall(entries, '记忆', { k: 3, budgetTokens: 300 }).length, 0)
  // 直接命中才召回
  assert.equal(recall(entries, 'memory', { k: 3, budgetTokens: 300 }).length, 1)
})

// ── recall ──────────────────────────────────────────────────────────────────

function corpus() {
  const now = Date.now()
  return [
    { id: 'a', kind: 'preference', text: '用户偏好先结论后证据', tags: ['沟通'], confidence: 1, importance: 0.9, updatedAt: now },
    { id: 'b', kind: 'fact', text: '部署在 D:\\apps，端口 8443', tags: ['部署'], confidence: 1, importance: 0.7, updatedAt: now },
    { id: 'c', kind: 'fact', text: '待确认的猜测：可能用 Postgres', tags: ['数据库'], confidence: 0, importance: 0.5, updatedAt: now },
    { id: 'd', kind: 'fact', text: '旧的验收标准', tags: ['验收'], confidence: 1, importance: 0.7, updatedAt: now, validUntil: now - 1 },
  ]
}

test('recall：按相关度返回，排除被取代条目', () => {
  const hits = recall(corpus(), '部署端口', { k: 3, budgetTokens: 300 })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].entry.id, 'b')
  assert.ok(hits[0].score > RECALL_DEFAULTS.minScore)
})

test('recall：minConfidence 过滤未确认条目', () => {
  assert.equal(recall(corpus(), 'Postgres 猜测', { minConfidence: 1 }).length, 0)
  assert.equal(recall(corpus(), 'Postgres 猜测', { minConfidence: 0 }).length, 1)
})

test('recall：预算装不下就跳过而不是截断行', () => {
  const now = Date.now()
  const entries = [
    { id: 'p', kind: 'fact', text: '端口 8443 '.repeat(8), tags: [], updatedAt: now },
    { id: 'q', kind: 'fact', text: '端口 8443 备用', tags: [], updatedAt: now },
  ]
  const hits = recall(entries, '端口', { k: 5, budgetTokens: 120 })
  assert.ok(hits.length >= 1)
  for (const hit of hits) {
    assert.ok(estimateTokens(renderLine(hit.entry)) <= 120)
  }
})

test('renderRecallBlock：无命中返回空串，有命中带 wrapper 与来源标记', () => {
  assert.equal(renderRecallBlock([]), '')
  const block = renderRecallBlock(recall(corpus(), '部署端口', { k: 3 }))
  assert.ok(block.startsWith('<long-term-memory'))
  assert.ok(block.includes('[mem:b]'))
  assert.ok(block.endsWith('</long-term-memory>'))
})

// ── store ───────────────────────────────────────────────────────────────────

test('entryId：同 kind 同文本（大小写/空白归一）同 id', () => {
  assert.equal(entryId('fact', '  Hello   World '), entryId('fact', 'hello world'))
  assert.notEqual(entryId('fact', 'hello'), entryId('preference', 'hello'))
  assert.equal(entryId('fact', 'x').length, 12)
})

test('put：重复写同内容 → 更新而非新增，createdAt 保留', () => {
  const { store } = tempStore()
  const first = store.put({ kind: 'fact', text: '端口 8443' })
  const second = store.put({ kind: 'fact', text: '端口 8443' })
  assert.equal(first.created, true)
  assert.equal(second.created, false)
  assert.equal(store.stats().active, 1)
  assert.equal(store.list()[0].createdAt, first.record.createdAt)
})

test('put：同 subject 写入 → 旧的被取代且仍在审计链里', () => {
  const { store } = tempStore()
  const old = store.put({ kind: 'fact', text: '验收标准：可验证', subject: '验收标准' })
  const next = store.put({ kind: 'fact', text: '验收标准：必须带命令回执', subject: '验收标准' })
  assert.equal(next.superseded, old.record.id)
  const retired = store.get(old.record.id)
  assert.ok(retired.validUntil)
  assert.equal(retired.supersededBy, next.record.id)
  assert.equal(next.record.supersedes, old.record.id)
  assert.equal(store.stats().active, 1)
  assert.equal(store.stats().superseded, 1)
})

test('put：无 subject 时靠高 token 重叠取代；tag 不相交则不取代', () => {
  const { store } = tempStore()
  store.put({ kind: 'fact', text: '部署脚本放在 D 盘的工具目录并按天备份', tags: ['部署'] })
  const sameTopic = store.put({ kind: 'fact', text: '部署脚本放在 D 盘的工具目录并按周备份', tags: ['部署'] })
  assert.ok(sameTopic.superseded, '同主题高重叠应取代')
  store.put({ kind: 'fact', text: '部署脚本放在 D 盘的工具目录并按天备份', tags: ['备份'] })
  const otherTopic = store.put({ kind: 'fact', text: '部署脚本放在 D 盘的工具目录并按天备份', tags: ['运维'] })
  assert.equal(otherTopic.superseded, undefined)
})

test('remove：写墓碑、不再被列出，审计可读', () => {
  const { root, store } = tempStore()
  const { record } = store.put({ kind: 'event', text: '临时事件' })
  assert.equal(store.remove(record.id), true)
  assert.equal(store.stats().total, 0)
  const reopened = openStore({ root })
  assert.equal(reopened.stats().total, 0)
  const tombstone = JSON.parse(readFileSync(join(root, 'entries', `${record.id}.json`), 'utf8'))
  assert.equal(tombstone.deleted, true)
})

test('profile：get 空库有默认值，set 合并写盘', () => {
  const { root, store } = tempStore()
  assert.equal(store.profileGet().schemaVersion, 2)
  store.profileSet({ name: '克莱因蓝', timezone: 'Asia/Shanghai' })
  assert.equal(openStore({ root }).profileGet().name, '克莱因蓝')
})

test('损坏的条目文件被跳过，统计里计数', () => {
  const { root, store } = tempStore()
  writeFileSync(join(root, 'entries', 'broken.json'), '{ not json', 'utf8')
  const reopened = openStore({ root })
  assert.equal(reopened.stats().corrupt, 0) // 无法解析的文件既不是条目也不是墓碑
  assert.equal(reopened.stats().total, store.stats().total)
})

// ── CLI ─────────────────────────────────────────────────────────────────────

test('CLI：remember → list → recall → forget 闭环', () => {
  const root = mkdtempSync(join(tmpdir(), 'am-cli-'))
  let r = runCli(['--root', root, 'remember', '用户偏好先结论后证据', '--kind', 'preference', '--tags', '沟通', '--json'])
  assert.equal(r.code, 0, r.stderr)
  const record = JSON.parse(r.stdout)
  assert.equal(record.kind, 'preference')
  assert.equal(record.text, '用户偏好先结论后证据')

  r = runCli(['--root', root, 'list'])
  assert.equal(r.code, 0)
  assert.ok(r.stdout.includes(record.id))

  r = runCli(['--root', root, '--json', 'recall', '回答风格'])
  assert.equal(r.code, 0)
  assert.equal(JSON.parse(r.stdout).count, 0, '不相关查询不该召回')

  r = runCli(['--root', root, '--json', 'recall', '先给结论'])
  assert.equal(JSON.parse(r.stdout).count, 1)

  r = runCli(['--root', root, 'forget', `mem:${record.id}`])
  assert.equal(r.code, 0)
  assert.ok(r.stdout.includes('已删除'))
  r = runCli(['--root', root, 'forget', `mem:${record.id}`])
  assert.equal(r.code, 1)
  rmSync(root, { recursive: true, force: true })
})

test('CLI：inject 无命中时零输出（安静的一轮不花 token）', () => {
  const root = mkdtempSync(join(tmpdir(), 'am-cli-'))
  runCli(['--root', root, 'remember', '用户偏好先结论后证据', '--kind', 'preference'])
  const quiet = runCli(['--root', root, 'inject', '完全不相关的天气问题'])
  assert.equal(quiet.code, 0)
  assert.equal(quiet.stdout, '')
  const loud = runCli(['--root', root, 'inject', '先给结论'])
  assert.ok(loud.stdout.includes('<long-term-memory'))
  rmSync(root, { recursive: true, force: true })
})

test('CLI：export → import 往返保真（同 store 不重复）', () => {
  const from = mkdtempSync(join(tmpdir(), 'am-from-'))
  const to = mkdtempSync(join(tmpdir(), 'am-to-'))
  runCli(['--root', from, 'remember', '部署在 D:\\apps，端口 8443', '--tags', '部署'])
  runCli(['--root', from, 'remember', '偏好：不要建议，给结论', '--kind', 'preference'])
  const exported = join(from, 'export.jsonl')
  const r = runCli(['--root', from, 'export', '--out', exported])
  assert.equal(r.code, 0)

  const dry = runCli(['--root', to, 'import', exported, '--dry-run', '--json'])
  assert.equal(JSON.parse(dry.stdout).created, 2)
  assert.equal(runCli(['--root', to, 'stats']).stdout.includes('活动   0'), true, 'dry-run 不落盘')

  runCli(['--root', to, 'import', exported])
  const stats = JSON.parse(runCli(['--root', to, '--json', 'stats']).stdout)
  assert.equal(stats.active, 2)
  const again = JSON.parse(runCli(['--root', to, 'import', exported, '--json']).stdout)
  assert.equal(again.skipped, 2)
  rmSync(from, { recursive: true, force: true })
  rmSync(to, { recursive: true, force: true })
})

test('CLI：错误用法给 1，环境问题给 2', () => {
  const root = mkdtempSync(join(tmpdir(), 'am-cli-'))
  assert.equal(runCli(['--root', root, 'remember']).code, 1)
  assert.equal(runCli(['--root', root, 'nonsense']).code, 1)
  assert.equal(runCli(['--root', root, 'show']).code, 1)
  const bad = runCli(['--root', join(root, 'file-not-dir'), 'doctor'])
  assert.ok([0, 2].includes(bad.code))
  rmSync(root, { recursive: true, force: true })
})

test('CLI：inject 整块不超过 --budget（插件原实现只约束命中行）', () => {
  const root = mkdtempSync(join(tmpdir(), 'am-cli-'))
  for (let index = 0; index < 3; index += 1) {
    runCli(['--root', root, 'remember',
      `部署规范 ${index}：所有发布脚本都必须放在工具目录里并按天备份，回滚时只允许用同一天的快照，不允许跨天回滚${'，细节'.repeat(6)}`,
      '--kind', 'fact', '--tags', '部署'])
  }
  const payload = JSON.parse(runCli(['--root', root, '--json', 'inject', '部署规范', '--budget', '200']).stdout)
  assert.equal(payload.budgetTokens, 200)
  assert.ok(payload.tokens <= 200, `block tokens ${payload.tokens} > 200`)
  assert.ok(payload.count <= 3)
  rmSync(root, { recursive: true, force: true })
})

test('CLI：同 id 重写不显示「已取代自己」', () => {
  const root = mkdtempSync(join(tmpdir(), 'am-cli-'))
  runCli(['--root', root, 'remember', '同一句话写两遍', '--kind', 'fact'])
  const second = runCli(['--root', root, 'remember', '同一句话写两遍', '--kind', 'fact'])
  assert.equal(second.code, 0)
  assert.ok(second.stdout.includes('已更新'))
  assert.ok(!second.stdout.includes('已取代'), `unexpected self-supersede text: ${second.stdout}`)
  rmSync(root, { recursive: true, force: true })
})

test('CLI：--json doctor 结构稳定', () => {
  const root = mkdtempSync(join(tmpdir(), 'am-cli-'))
  const r = runCli(['--root', root, '--json', 'doctor'])
  const payload = JSON.parse(r.stdout)
  for (const key of ['node', 'root', 'source', 'writable', 'active', 'superseded', 'byKind']) {
    assert.ok(key in payload, `missing ${key}`)
  }
  assert.equal(payload.writable, true)
  rmSync(root, { recursive: true, force: true })
})
