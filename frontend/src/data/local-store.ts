import {
  ENTRIES_KEY,
  SHIELD_ARCHIVE_KEY,
  SHIELD_ARCHIVE_VERSION,
  readJson,
  writeJson,
} from './kv'
import { SEED_ROWS } from './seed'
import {
  buildShieldArchive,
  SHIELD_KEY,
  SHIELD_ARCHIVE_FIELDS,
} from './shield-archive'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export type ShieldArchiveState = {
  version: number
  items: EntryRow[]
  updatedAt: string
}

export type DataCache = {
  entries: Record<string, EntryRow[]>
  shield: ShieldArchiveState
}

function seedArchive(): ShieldArchiveState {
  const { items } = buildShieldArchive(clone(SEED_ROWS[SHIELD_KEY] ?? []))
  return { version: SHIELD_ARCHIVE_VERSION, items, updatedAt: new Date(0).toISOString() }
}

function seedEntries(): Record<string, EntryRow[]> {
  const entries = clone(SEED_ROWS)
  entries[SHIELD_KEY] = seedArchive().items
  return entries
}

function migrateShield(
  entries: Record<string, EntryRow[]>,
  stored: ShieldArchiveState | null,
): ShieldArchiveState {
  if (stored && stored.version >= SHIELD_ARCHIVE_VERSION && Array.isArray(stored.items)) {
    // 已在档案版本上：存量设备仍按统一算法重新过一遍，保证算法升级后读法一致。
    const rebuilt = buildShieldArchive(clone(stored.items))
    return {
      version: SHIELD_ARCHIVE_VERSION,
      items: rebuilt.items,
      updatedAt: stored.updatedAt,
    }
  }
  // 旧版本或没有档案：设备档案以通用台账（含补录/旧记录）为来源整体迁入、去重、归一。
  const rebuilt = buildShieldArchive(clone(entries[SHIELD_KEY] ?? SEED_ROWS[SHIELD_KEY] ?? []))
  return { version: SHIELD_ARCHIVE_VERSION, items: rebuilt.items, updatedAt: new Date(0).toISOString() }
}

function readStorage(): DataCache {
  const fallbackEntries = seedEntries()
  if (typeof window === 'undefined' || !window.localStorage) {
    return { entries: fallbackEntries, shield: seedArchive() }
  }

  let storedEntries = readJson<Record<string, EntryRow[]>>(ENTRIES_KEY)
  let storedShield = readJson<ShieldArchiveState>(SHIELD_ARCHIVE_KEY)

  if (!storedEntries) {
    storedEntries = fallbackEntries
  } else {
    // 通用模块仍沿用旧的 seed 兜底合并方式，盾构机这一路之后会被档案覆盖。
    storedEntries = { ...clone(SEED_ROWS), ...storedEntries }
  }

  const shield = migrateShield(storedEntries, storedShield)
  storedEntries[SHIELD_KEY] = clone(shield.items)

  // 一次性把迁移结果落盘；两个 key 都写完才算迁入完成。
  writeJson(ENTRIES_KEY, storedEntries)
  writeJson(SHIELD_ARCHIVE_KEY, shield)

  return { entries: storedEntries, shield }
}

let cache: DataCache | null = null

export function allRows(): Record<string, EntryRow[]> {
  return getCache().entries
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function getCache(): DataCache {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

/** 盾构机唯一取数口：列表、导出、打包、看板台数都从这里拿。 */
export function shieldRows(): EntryRow[] {
  return getCache().shield.items
}

/**
 * 跨表事务：设备档案与通用台账（看板等入口共用）必须一起改。
 * 先在内存里改好并校验，落盘时任意一个 key 写失败，就把改动前的两个 key
 * 整体写回去；写不成就整笔退回，绝不给档案落半条、给台账留旧影。
 */
export function commitShieldArchive(
  mutate: (draft: EntryRow[]) => EntryRow[],
): { items: EntryRow[]; updatedAt: string } {
  const before = getCache()
  const entriesSnapshot = clone(before.entries)
  const shieldSnapshot = clone(before.shield)

  let nextItems: EntryRow[]
  try {
    nextItems = mutate(clone(before.shield.items))
  } catch (error) {
    // 业务校验抛错：什么都没写，直接抛回，调用方提示用户。
    throw error
  }
  const updatedAt = new Date().toISOString()
  const nextShield: ShieldArchiveState = {
    version: SHIELD_ARCHIVE_VERSION,
    items: nextItems,
    updatedAt,
  }
  const nextEntries = { ...before.entries, [SHIELD_KEY]: clone(nextItems) }

  try {
    writeJson(SHIELD_ARCHIVE_KEY, nextShield)
    writeJson(ENTRIES_KEY, nextEntries)
  } catch (error) {
    // 整笔退回：尝试恢复旧值；恢复也失败时清缓存，下次读盘重建，内存不留半态。
    try {
      writeJson(SHIELD_ARCHIVE_KEY, shieldSnapshot)
      writeJson(ENTRIES_KEY, entriesSnapshot)
    } catch {
      cache = null
    }
    throw error instanceof Error ? error : new Error('设备档案写入失败，已整笔退回')
  }

  cache = { entries: nextEntries, shield: nextShield }
  return { items: nextItems, updatedAt }
}

export function saveRows(key: string, rows: EntryRow[]): void {
  if (key === SHIELD_KEY) {
    // 盾构机只准走设备档案事务，绕过档案直接改台账会造成两份数据再次分叉。
    throw new Error('盾构机数据必须经过设备档案提交，请改用设备档案的写接口')
  }
  const next = { ...allRows(), [key]: rows }
  cache = { entries: next, shield: getCache().shield }
  if (typeof window !== 'undefined' && window.localStorage) {
    writeJson(ENTRIES_KEY, next)
  }
}

export function resetRows(key: string): EntryRow[] {
  if (key === SHIELD_KEY) {
    return resetShieldArchive().items
  }
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function resetShieldArchive(): ShieldArchiveState {
  const archive = seedArchive()
  commitShieldArchive(() => clone(archive.items))
  return archive
}

export function shieldArchiveUpdatedAt(): string {
  return getCache().shield.updatedAt
}

export function shieldFields(): string[] {
  return SHIELD_ARCHIVE_FIELDS
}

export function storageKey(): string {
  return ENTRIES_KEY
}
