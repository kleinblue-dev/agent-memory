/**
 * lib/store.mjs — durable memory store, zero dependencies.
 *
 * Ported 1:1 from dsh-plugin-personal-agent 1.4.1 `lib/store.js`. The on-disk
 * format is intentionally unchanged so this CLI and the DSH plugin can read and
 * write the same directory (the plugin keeps working; nothing needs migrating).
 *
 * Layout (one JSON file per entry, so a corrupt record cannot take the whole
 * memory down):
 *
 *   <root>/entries/<id>.json
 *   <root>/profile.json   { schemaVersion, name, timezone, locale, preferences, notes, updatedAt }
 *
 * Entry record (schemaVersion 2 adds the governance fields):
 *   id, kind, text, tags, confidence
 *   importance   0..1   — retrieval weight; higher survives competition for the budget
 *   subject      string — optional slot key; re-stating the same subject supersedes
 *   validFrom    ms     — bi-temporal: when this statement became true
 *   validUntil   ms|null— when it stopped being active; active iff null
 *   supersedes   id|null, supersededBy id|null — audit chain, never destroyed
 *   sourceSessionId, createdAt, updatedAt
 *
 * Writes are write-temp + rename (atomic on the same volume). All reads/writes are
 * synchronous: the set is small (target < 5k entries) and recall during prompt
 * assembly must be synchronous.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { defaultImportance, tokenize } from './recall.mjs'

export const SCHEMA_VERSION = 2
export const KINDS = new Set(['fact', 'preference', 'event', 'task', 'person'])
export const MAX_TEXT = 200
export const MAX_SUBJECT = 60
export const MAX_TAGS = 8
export const MAX_TAG_LEN = 24
/** Same kind + this much token overlap = the same statement restated, so supersede. */
export const SUPERSEDE_JACCARD = 0.55
/** Never supersede on a handful of shared tokens, however common they are. */
export const SUPERSEDE_MIN_SHARED = 6

export function normalize(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

export function entryId(kind, text) {
  return createHash('sha1').update(`${kind}\u0000${normalize(text).toLowerCase()}`).digest('hex').slice(0, 12)
}

function clamp01(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return undefined
  return Math.min(1, Math.max(0, number))
}

function jaccard(aTokens, bTokens) {
  const a = new Set(aTokens)
  const b = new Set(bTokens)
  if (a.size === 0 || b.size === 0) return { score: 0, shared: 0 }
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  return { score: shared / (a.size + b.size - shared), shared }
}

function writeAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function readRaw(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

export function openStore(options = {}) {
  const root = options.root
  if (!root) throw new Error('openStore: `root` is required')
  const entriesDir = join(root, 'entries')
  const profileFile = join(root, 'profile.json')

  mkdirSync(entriesDir, { recursive: true })
  const entries = new Map()
  let corrupt = 0
  for (const name of readdirSync(entriesDir)) {
    if (!name.endsWith('.json')) continue
    const raw = readRaw(join(entriesDir, name))
    if (raw === undefined) { corrupt += 1; continue } // 读不了
    let record
    try { record = JSON.parse(raw) } catch { corrupt += 1; continue } // 坏 JSON（不是合法的「坏条目」，如实计数）
    if (record && typeof record.id === 'string' && typeof record.text === 'string') entries.set(record.id, record)
    else if (!(record && record.deleted === true)) corrupt += 1
  }

  function isActive(entry) {
    return !entry.validUntil
  }

  function list(options = {}) {
    const includeInactive = options.includeInactive === true
    return [...entries.values()]
      .filter((entry) => includeInactive || isActive(entry))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  }

  function get(id) {
    return entries.get(String(id))
  }

  /**
   * The entry this new statement replaces, if any:
   *  1. same explicit `subject` (the reliable, model-provided signal), else
   *  2. the same kind restated with >=55% token overlap (Jaccard, >=6 shared
   *     tokens) — catches "验收标准改成…" style rewrites with no subject.
   * Only active entries are candidates: superseded history stays untouched so the
   * audit chain keeps the old value.
   */
  function findSupersedeTarget({ kind, text, subject, tags }) {
    const candidates = [...entries.values()].filter((entry) => isActive(entry) && entry.kind === kind)
    if (subject) {
      const bySubject = candidates.find((entry) => entry.subject && entry.subject === subject)
      if (bySubject) return bySubject
    }
    const tokens = tokenize(text)
    let best
    let bestScore = 0
    for (const entry of candidates) {
      // Tags are the entry's topic. Two statements carrying disjoint explicit topics
      // are different statements even when they share boilerplate wording.
      if (tags.length && entry.tags?.length && !tags.some((tag) => entry.tags.includes(tag))) continue
      const overlap = jaccard(tokens, tokenize(entry.text))
      if (overlap.shared < SUPERSEDE_MIN_SHARED) continue
      if (overlap.score > bestScore) {
        bestScore = overlap.score
        best = entry
      }
    }
    return bestScore >= SUPERSEDE_JACCARD ? best : undefined
  }

  /** Insert or update by (kind,text) identity; keeps the oldest createdAt. */
  function put(input = {}) {
    const kind = KINDS.has(input.kind) ? input.kind : 'fact'
    const text = normalize(input.text).slice(0, MAX_TEXT)
    if (!text) throw new Error('memory: `text` is required and must not be empty')
    const id = entryId(kind, text)
    const now = Date.now()
    const previous = entries.get(id)
    const tags = Array.isArray(input.tags)
      ? input.tags.map((t) => normalize(t).slice(0, MAX_TAG_LEN)).filter(Boolean).slice(0, MAX_TAGS)
      : []
    const subjectRaw = normalize(input.subject ?? '').slice(0, MAX_SUBJECT)
    const importance =
      clamp01(input.importance) ?? clamp01(previous?.importance) ?? defaultImportance({ kind, tags, confidence: input.confidence })
    const target = findSupersedeTarget({ kind, text, subject: subjectRaw || undefined, tags })
    const record = {
      id,
      kind,
      text,
      tags,
      confidence: [0, 1, 2].includes(input.confidence) ? input.confidence : (previous?.confidence ?? 1),
      importance,
      subject: subjectRaw || undefined,
      sourceSessionId: input.sourceSessionId ? String(input.sourceSessionId) : previous?.sourceSessionId,
      createdAt: previous?.createdAt ?? now,
      validFrom: previous?.validFrom ?? now,
      validUntil: null,
      supersedes: target?.id ?? previous?.supersedes ?? null,
      supersededBy: null,
      updatedAt: now,
    }
    writeAtomic(join(entriesDir, `${id}.json`), record)
    entries.set(id, record)
    if (target && target.id !== id) {
      const retired = { ...target, validUntil: now, supersededBy: id, updatedAt: now }
      writeAtomic(join(entriesDir, `${target.id}.json`), retired)
      entries.set(target.id, retired)
    }
    return { record, created: !previous, superseded: target?.id }
  }

  /** Soft-retire instead of deleting: keeps the audit chain, removes it from recall. */
  function supersede(id, byId) {
    const key = String(id)
    const entry = entries.get(key)
    if (!entry || !isActive(entry)) return false
    const retired = { ...entry, validUntil: Date.now(), supersededBy: byId ? String(byId) : null, updatedAt: Date.now() }
    writeAtomic(join(entriesDir, `${key}.json`), retired)
    entries.set(key, retired)
    return true
  }

  /** Tombstone instead of unlink: an audit reader can still see what was removed. */
  function remove(id) {
    const key = String(id)
    if (!entries.has(key)) return false
    entries.delete(key)
    try {
      writeAtomic(join(entriesDir, `${key}.json`), { deleted: true, id: key, deletedAt: Date.now() })
    } catch {
      /* best effort: the in-memory view already reflects the deletion */
    }
    return true
  }

  /**
   * Migration-only: write a record back **verbatim** (no supersede, no dedupe by
   * content), preserving id / timestamps / validUntil / the supersedes chain.
   *
   * Replaying an export through `put()` would resurrect retired entries and let an
   * old value supersede the current truth — that is exactly the data-loss bug this
   * method exists to avoid. Tombstones are not stored as entries, so they are not
   * imported either (they stay in the source store's files).
   */
  function importRecord(record, options = {}) {
    const force = options.force === true
    if (!record || typeof record !== 'object') return { ok: false, reason: 'invalid' }
    const text = typeof record.text === 'string' ? record.text : ''
    const kind = KINDS.has(record.kind) ? record.kind : null
    if (!text || !kind) return { ok: false, reason: 'invalid' }
    const id = typeof record.id === 'string' && record.id ? record.id : entryId(kind, text)
    const previous = entries.get(id)
    if (previous && !force) return { ok: false, reason: 'exists', id }

    // 原样保留：磁盘上有哪些键，写回去就有哪些键（v1 老条目没有 importance/validUntil 等，
    // 迁移后也不能凭空多出来，否则「二次导出与首次一致」不成立）。
    const next = { ...record, id, kind, text }
    if (next.tags === undefined || !Array.isArray(next.tags)) next.tags = []
    else next.tags = next.tags.filter((tag) => typeof tag === 'string')
    if (![0, 1, 2].includes(next.confidence)) next.confidence = previous?.confidence ?? 1
    // importance 缺失时**不补**：v1 老条目本就没有这个字段，补了会破坏迁移保真；
    // 读取侧一律用 `entry.importance ?? defaultImportance(entry)`，行为不变。
    if (next.importance !== undefined && !Number.isFinite(Number(next.importance))) delete next.importance
    if (next.createdAt === undefined || !Number.isFinite(Number(next.createdAt))) {
      next.createdAt = previous?.createdAt ?? Date.now()
    }
    if (next.updatedAt === undefined) next.updatedAt = Date.now()
    if (next.subject !== undefined) next.subject = normalize(next.subject).slice(0, MAX_SUBJECT) || undefined
    writeAtomic(join(entriesDir, `${id}.json`), next)
    entries.set(id, next)
    return { ok: true, id, created: !previous }
  }

  function profileGet() {
    const stored = readJson(profileFile)
    return stored && typeof stored === 'object' ? stored : { schemaVersion: SCHEMA_VERSION }
  }

  function profileSet(patch = {}) {
    const next = { ...profileGet(), ...patch, schemaVersion: SCHEMA_VERSION, updatedAt: Date.now() }
    writeAtomic(profileFile, next)
    return next
  }

  function stats() {
    const byKind = {}
    let active = 0
    let superseded = 0
    for (const entry of entries.values()) {
      if (isActive(entry)) {
        active += 1
        byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1
      } else {
        superseded += 1
      }
    }
    return { root, total: entries.size, active, superseded, byKind, corrupt }
  }

  return {
    root, list, get, put, supersede, remove, importRecord,
    profileGet, profileSet, stats, isActive, exists: existsSync(entriesDir),
  }
}
