import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'shield-tunnel-construction:entries'

// v2：外面再套一层壳子，entries 存各模块记录，meta 存结构版本，一次落盘整体提交。
// v1 是早期裸表（直接就是 Record<模块, 行[]>），读取时兼容，首次做域迁移时升到 v2。
export const CURRENT_SCHEMA = 2

export type EntriesMap = Record<string, EntryRow[]>

export type StoreShape = {
  schemaVersion: number
  entries: EntriesMap
  meta: Record<string, unknown>
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function seedStore(): StoreShape {
  return { schemaVersion: 1, entries: clone(SEED_ROWS), meta: {} }
}

function normalize(raw: unknown): StoreShape {
  if (raw && typeof raw === 'object' && Array.isArray((raw as StoreShape).entries)) {
    // 防御：entries 被写成数组的脏数据，整体回到种子，不带着脏数据往后走。
    return seedStore()
  }
  if (raw && typeof raw === 'object' && 'entries' in (raw as Record<string, unknown>)) {
    const shaped = raw as StoreShape
    return {
      schemaVersion: Number(shaped.schemaVersion) || 1,
      entries: { ...clone(SEED_ROWS), ...(clone(shaped.entries) as EntriesMap) },
      meta: clone(shaped.meta ?? {}),
    }
  }
  if (raw && typeof raw === 'object') {
    // v1 裸表：包一层壳，保持版本 1，交给域层做迁移。
    return { schemaVersion: 1, entries: { ...clone(SEED_ROWS), ...(clone(raw) as EntriesMap) }, meta: {} }
  }
  return seedStore()
}

// localStorage 不可用（隐私模式/测试环境）时退到内存表，接口行为保持一致。
let memory: StoreShape | null = null

function readStorage(): StoreShape {
  if (typeof window === 'undefined' || !window.localStorage) {
    if (!memory) {
      memory = seedStore()
    }
    return memory
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seeded = seedStore()
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded))
    return seeded
  }
  try {
    return normalize(JSON.parse(raw))
  } catch {
    const seeded = seedStore()
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded))
    return seeded
  }
}

function writeStorage(store: StoreShape): void {
  const serialized = JSON.stringify(store)
  if (typeof window !== 'undefined' && window.localStorage) {
    // 一次性写入：写不进去（配额超限等）时 localStorage 保持原样，不会落成半包。
    window.localStorage.setItem(STORAGE_KEY, serialized)
  } else {
    memory = store
  }
}

let cache: StoreShape | null = null

export function getStore(): StoreShape {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function allRows(): EntriesMap {
  return getStore().entries
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  mutate((draft) => {
    draft.entries[key] = rows
  })
}

// 事务入口：草稿上随便改，提交点只有一个；回调抛错就整笔退回，调用方拿到失败结果，库里不留半条。
export function mutate<T>(fn: (draft: StoreShape) => T): T {
  const base = getStore()
  const draft: StoreShape = {
    schemaVersion: base.schemaVersion,
    entries: clone(base.entries),
    meta: clone(base.meta),
  }
  const result = fn(draft)
  writeStorage(draft)
  cache = draft
  return result
}

// 重置单模块：只回滚指定模块，事务里顺手写一个迁移标记，版本随迁移一起提交。
export function resetRows(key: string): EntryRow[] {
  return mutate((draft) => {
    const rows = clone(SEED_ROWS[key] ?? [])
    draft.entries[key] = rows
    if (key === 'shield') {
      // 盾构机回到种子即回到迁移前状态，清掉版本与标记，让对账迁移重新跑一遍。
      draft.schemaVersion = 1
      delete draft.meta.shieldArchiveMigrated
    }
    return rows
  })
}

export function storageKey(): string {
  return STORAGE_KEY
}
