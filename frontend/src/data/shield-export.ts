import { readJson, writeJson } from './kv'
import type { EntryRow } from './types'

/**
 * 盾构机清单的断点导出：导出可能中途被打断，把进度会话落到 localStorage，
 * 下次从断掉的那台接着打；档案一旦在会话期间变过，旧断点作废、整份重打，
 * 避免把改动前后的数据拼成一份串号的文件。
 * 会话只记录「打到第几台」，最终文件在 finish 时一次性生成，磁盘上不会留半包文件。
 */

const SESSION_KEY = 'shield-tunnel-construction:shield-export-session'
const BATCH_UNIT = 1

export type ExportSession = {
  total: number
  doneIds: number[]
  signature: string
  startedAt: string
  updatedAt: string
}

/** 档案签名：台数、编号顺序与档案更新时间拼在一起，任意一项变了都视为档案已变。 */
export function archiveSignature(items: EntryRow[], archiveUpdatedAt: string): string {
  return `${items.length}:${items.map((row) => row.id).join('-')}@${archiveUpdatedAt}`
}

function readSession(): ExportSession | null {
  return readJson<ExportSession>(SESSION_KEY)
}

function persist(session: ExportSession): void {
  writeJson(SESSION_KEY, { ...session, updatedAt: new Date().toISOString() })
}

export function startExport(items: EntryRow[], archiveUpdatedAt: string): ExportSession {
  const session: ExportSession = {
    total: items.length,
    doneIds: [],
    signature: archiveSignature(items, archiveUpdatedAt),
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  persist(session)
  return session
}

export function currentExportSession(
  items: EntryRow[],
  archiveUpdatedAt: string,
): ExportSession | null {
  const session = readSession()
  if (!session || session.signature !== archiveSignature(items, archiveUpdatedAt)) {
    return null
  }
  return session
}

export function cancelExport(): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(SESSION_KEY)
  }
}

export type ExportChunkResult = {
  session: ExportSession
  batch: EntryRow[]
  finished: boolean
  restarted: boolean
}

/**
 * 从断掉的那台接着打：一次推进 BATCH_UNIT 台（页面上可循环调用直到 finished）。
 * 档案变了就从头重打；重复推进同一台不会重复计数（断点本身幂等）。
 */
export function advanceExport(
  items: EntryRow[],
  archiveUpdatedAt: string,
  unit: number = BATCH_UNIT,
): ExportChunkResult {
  const signature = archiveSignature(items, archiveUpdatedAt)
  let session = readSession()
  let restarted = false
  if (!session) {
    session = { total: items.length, doneIds: [], signature, startedAt: new Date().toISOString(), updatedAt: '' }
    restarted = true
  } else if (session.signature !== signature) {
    // 档案变了：旧半包作废，从第一台重新打。
    session = { total: items.length, doneIds: [], signature, startedAt: new Date().toISOString(), updatedAt: '' }
    restarted = true
  }

  const batch: EntryRow[] = []
  for (const row of items) {
    if (session.doneIds.includes(Number(row.id))) {
      continue
    }
    batch.push(row)
    if (batch.length >= unit) {
      break
    }
  }
  for (const row of batch) {
    if (!session.doneIds.includes(Number(row.id))) {
      session.doneIds.push(Number(row.id))
    }
  }
  const finished = items.every((row) => session!.doneIds.includes(Number(row.id)))
  if (finished) {
    // 全部打完才交文件，会话清掉，任何地方都不会留半包。
    cancelExport()
  } else {
    persist(session)
  }
  return { session, batch, finished, restarted }
}
