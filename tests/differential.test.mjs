/**
 * Differential tests: the standalone port must behave identically to the
 * dsh-plugin-personal-agent memory layer it was extracted from.
 *
 * Skipped automatically when the plugin checkout is absent (e.g. on a fresh
 * clone of this repo), so `node --test` stays green for everyone.
 *
 *   PA_PLUGIN_DIR=/path/to/personal-agent node --test tests/differential.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import * as portRecall from '../lib/recall.mjs'
import * as portStore from '../lib/store.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

// 移植源：默认按仓库相对位置找（<workspace>/agent-memory/tests/../../plugins/personal-agent），
// 也可以用 PA_PLUGIN_DIR 指向任意一份 dsh-plugin-personal-agent 检出。
const PLUGIN_DIR = process.env.PA_PLUGIN_DIR
  || join(HERE, '..', '..', 'plugins', 'personal-agent')
const AVAILABLE = existsSync(join(PLUGIN_DIR, 'lib', 'recall.js'))

const skip = AVAILABLE ? false : `未找到插件源码：${PLUGIN_DIR}（设 PA_PLUGIN_DIR 指向 dsh-plugin-personal-agent）`

async function loadPlugin() {
  const recallUrl = pathToFileURL(join(PLUGIN_DIR, 'lib', 'recall.js')).href
  const storeUrl = pathToFileURL(join(PLUGIN_DIR, 'lib', 'store.js')).href
  return { pluginRecall: await import(recallUrl), pluginStore: await import(storeUrl) }
}

const TEXTS = [
  '', '记忆', '我的记忆是长期记忆', 'The MEMORY is good', 'node v24.14.0',
  '用户偏好先结论后证据，给数字和路径', '部署在 D:\\2006L\\apps，端口 8443',
  '你觉得这个方案怎么样？', 'MCP 不是智能，是接口', 'a b c', '一二三', 'React 19 + Vite',
  '2026-11-01T22:37:07+08:00', 'Memory layer: recall budget 300 tokens',
]

test('tokenize 与插件逐条一致', { skip }, async () => {
  const { pluginRecall } = await loadPlugin()
  for (const text of TEXTS) {
    assert.deepEqual(portRecall.tokenize(text), pluginRecall.tokenize(text), `tokenize(${JSON.stringify(text)})`)
  }
})

test('estimateTokens / defaultImportance / decayOf 一致', { skip }, async () => {
  const { pluginRecall } = await loadPlugin()
  for (const text of TEXTS) assert.equal(portRecall.estimateTokens(text), pluginRecall.estimateTokens(text))
  const samples = [
    {}, { kind: 'fact' }, { kind: 'preference' }, { kind: 'person', tags: ['x'] },
    { kind: 'event', confidence: 0 }, { kind: 'task', confidence: 1, tags: ['a'] },
    { kind: 'task', confidence: 2 }, { kind: 'unknown', confidence: 2 },
  ]
  for (const entry of samples) {
    assert.equal(portRecall.defaultImportance(entry), pluginRecall.defaultImportance(entry), JSON.stringify(entry))
  }
  const now = 1_800_000_000_000
  for (const entry of samples) {
    const stamp = { ...entry, updatedAt: now - 12 * 3600 * 1000 }
    assert.equal(portRecall.decayOf(stamp, now), pluginRecall.decayOf(stamp, now), JSON.stringify(entry))
  }
})

test('expandWeights 一致（含中文别名双向展开）', { skip }, async () => {
  const { pluginRecall } = await loadPlugin()
  for (const text of TEXTS) {
    const mine = [...portRecall.expandWeights(text).entries()].sort()
    const theirs = [...pluginRecall.expandWeights(text).entries()].sort()
    assert.deepEqual(mine, theirs, `expandWeights(${JSON.stringify(text)})`)
  }
})

function buildCorpus() {
  const now = 1_800_000_000_000
  return [
    { id: 'a1', kind: 'preference', text: '用户偏好先结论后证据，给数字和路径', tags: ['沟通', '偏好'], confidence: 2, importance: 0.95, createdAt: now - 86400e3, updatedAt: now - 86400e3 },
    { id: 'b2', kind: 'fact', text: '视频发布 skill 装在 ~/.dsh/skills/video-publish', tags: ['video-publish', 'skill'], confidence: 1, importance: 0.75, createdAt: now - 3 * 86400e3, updatedAt: now - 3 * 86400e3 },
    { id: 'c3', kind: 'fact', text: '项目部署在 D:\\2006L\\apps，端口 8443', tags: ['部署'], confidence: 1, importance: 0.7, createdAt: now - 30 * 86400e3, updatedAt: now - 30 * 86400e3 },
    { id: 'd4', kind: 'fact', text: '待确认：可能用 Postgres 做存储', tags: ['数据库'], confidence: 0, importance: 0.5, createdAt: now, updatedAt: now },
    { id: 'e5', kind: 'event', text: '2026-10-25 视频流水线全自动运行', tags: ['视频'], confidence: 1, importance: 0.4, createdAt: now - 5 * 86400e3, updatedAt: now - 5 * 86400e3 },
    { id: 'f6', kind: 'preference', text: '旧的沟通偏好：先给长解释', tags: ['沟通'], confidence: 1, importance: 0.9, createdAt: now - 60 * 86400e3, updatedAt: now - 60 * 86400e3, validUntil: now - 86400e3 },
  ]
}

const QUERIES = [
  '视频发布流程', '部署端口是多少', '回答风格', '先给结论',
  'memory recall', '记忆插件', 'Postgres 数据库', '完全不相关的话题：晚饭吃什么',
  '沟通偏好', 'skill 装在哪里',
]

test('recall 排序、分数、预算截断与插件完全一致', { skip }, async () => {
  const { pluginRecall } = await loadPlugin()
  const corpus = buildCorpus()
  const now = 1_800_000_000_000
  for (const query of QUERIES) {
    for (const options of [{ k: 3, budgetTokens: 300 }, { k: 8, budgetTokens: 800 }, { k: 3, budgetTokens: 300, minConfidence: 1 }]) {
      const mine = portRecall.recall(corpus, query, { ...options, now })
      const theirs = pluginRecall.recall(corpus, query, { ...options, now })
      assert.deepEqual(mine.map((hit) => hit.entry.id), theirs.map((hit) => hit.entry.id), `picks ${query} ${JSON.stringify(options)}`)
      mine.forEach((hit, index) => {
        assert.ok(Math.abs(hit.score - theirs[index].score) < 1e-12, `score ${query} #${index}`)
      })
      assert.equal(portRecall.renderRecallBlock(mine), pluginRecall.renderRecallBlock(theirs), `block ${query}`)
    }
  }
})

test('store：同一串写操作后条目/取代链/统计完全一致', { skip }, async () => {
  const { pluginStore } = await loadPlugin()
  const ops = [
    { kind: 'fact', text: '验收标准：所有结论必须可验证', subject: '验收标准', tags: ['验收'] },
    { kind: 'fact', text: '验收标准：结论必须可复现并且附命令回执', subject: '验收标准', tags: ['验收'] },
    { kind: 'preference', text: '沟通偏好：先结论后证据，不要铺垫', tags: ['沟通', '偏好'], confidence: 2 },
    { kind: 'fact', text: '部署脚本放在 D 盘工具目录并按天备份', tags: ['部署'] },
    { kind: 'fact', text: '部署脚本放在 D 盘工具目录并按周备份', tags: ['部署'] },
    { kind: 'fact', text: '部署脚本放在 D 盘工具目录并按天备份', tags: ['备份'] },
    { kind: 'event', text: '临时事件，稍后删除', tags: ['临时'] },
  ]
  const mineRoot = mkdtempSync(join(tmpdir(), 'am-port-'))
  const theirsRoot = mkdtempSync(join(tmpdir(), 'am-plugin-'))
  try {
    const mine = portStore.openStore({ root: mineRoot })
    const theirs = pluginStore.openStore({ root: theirsRoot })
    for (const op of ops) {
      const a = mine.put(op)
      const b = theirs.put(op)
      assert.equal(a.record.id, b.record.id, `id ${op.text}`)
      assert.equal(a.created, b.created)
      assert.equal(a.superseded ?? null, b.superseded ?? null, `superseded ${op.text}`)
    }
    // 删除一条，验证墓碑语义一致
    const target = mine.put({ kind: 'task', text: '一次性任务：验证内存层的持久化' })
    const target2 = theirs.put({ kind: 'task', text: '一次性任务：验证内存层的持久化' })
    assert.equal(mine.remove(target.record.id), theirs.remove(target2.record.id))

    const strip = (store) => store.list({ includeInactive: true }).map((entry) => {
      const { updatedAt, createdAt, validFrom, validUntil, ...rest } = entry
      return rest
    }).sort((a, b) => String(a.id).localeCompare(String(b.id)))
    assert.deepEqual(strip(mine), strip(theirs))

    const statKey = (stats) => ({ active: stats.active, superseded: stats.superseded, total: stats.total, byKind: stats.byKind })
    assert.deepEqual(statKey(mine.stats()), statKey(theirs.stats()))

    mine.profileSet({ name: '测试', timezone: 'Asia/Shanghai' })
    theirs.profileSet({ name: '测试', timezone: 'Asia/Shanghai' })
    const { updatedAt: _a, ...mineProfile } = mine.profileGet()
    const { updatedAt: _b, ...theirProfile } = theirs.profileGet()
    assert.deepEqual(mineProfile, theirProfile)
  } finally {
    rmSync(mineRoot, { recursive: true, force: true })
    rmSync(theirsRoot, { recursive: true, force: true })
  }
})

test('store：entryId 与插件一致（含大小写/空白归一）', { skip }, async () => {
  const { pluginStore } = await loadPlugin()
  const roots = [mkdtempSync(join(tmpdir(), 'am-id-')), mkdtempSync(join(tmpdir(), 'am-id-'))]
  try {
    const mine = portStore.openStore({ root: roots[0] })
    const theirs = pluginStore.openStore({ root: roots[1] })
    for (const text of ['  Hello   World ', '记忆层 v1', 'A\nB\tC']) {
      for (const kind of ['fact', 'preference', 'event', 'task', 'person']) {
        // 插件内部没有导出 entryId，用 put 落盘后的 id 作为对照。
        assert.equal(mine.put({ kind, text }).record.id, theirs.put({ kind, text }).record.id, `${kind}:${text}`)
        assert.equal(portStore.entryId(kind, text), mine.get(portStore.entryId(kind, text))?.id, 'roundtrip')
      }
    }
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  }
})
