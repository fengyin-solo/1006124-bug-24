import { getStore, mutate } from '@/data/local-store'
import {
  SHIELD_FIELDS,
  pendingRingsFor,
  selectShieldArchive,
  unassignedPendingRings,
} from '@/data/shield-domain'
import type { EntryRow } from '@/data/types'

// 导出/打包管线：与列表同一个取数口（设备档案），所以「列表台数 = 导出台数 = 打包清单台数」。
// 导出按台分批推进，每批落一个检查点；中断后从断掉那台接着打，未完成不产出文件，不留半包。

export type ExportKind = 'csv' | 'package'

export type ExportJob = {
  id: string
  kind: ExportKind
  filename: string
  // 计划内的台数与顺序，来自建档那一刻的档案快照（按编号排序，保证续导顺序稳定）。
  machineIds: number[]
  // 已打完的台数（检查点）：0..machineIds.length。
  cursor: number
  total: number
  status: 'running' | 'interrupted' | 'done'
  // 每行先转成 CSV 文本存起来，续导时只补没打过的台，重复台不会重复写。
  lines: string[]
  startedAt: string
  updatedAt: string
}

const JOB_META_KEY = 'shieldExportJobs'

type JobMap = Record<string, ExportJob>

function loadJobs(): JobMap {
  const meta = getStore().meta[JOB_META_KEY]
  return (meta && typeof meta === 'object' ? (meta as JobMap) : {}) ?? {}
}

function saveJob(job: ExportJob): void {
  mutate((draft) => {
    const jobs = ((draft.meta[JOB_META_KEY] as JobMap) ?? {}) as JobMap
    jobs[job.id] = job
    draft.meta[JOB_META_KEY] = jobs
  })
}

function csvCell(value: unknown): string {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function machineCsvLine(row: EntryRow): string {
  const pendingCount = pendingRingsFor(String(row.盾构机编号)).length
  return [
    row.id,
    ...SHIELD_FIELDS.map((field) => row[field] ?? ''),
    row.status,
    pendingCount,
  ]
    .map(csvCell)
    .join(',')
  }

function headerLine(): string {
  return ['编号', ...SHIELD_FIELDS, '当前状态', '未闭环环次'].map(csvCell).join(',')
}

// 一份导出计划：台数以档案快照为准；筛选条件与列表用的是同一个选择器。
export function createExportJob(kind: ExportKind, filters: Record<string, string> = {}): ExportJob {
  const snapshot = [...selectShieldArchive(filters)].sort((a, b) =>
    String(a.盾构机编号).localeCompare(String(b.盾构机编号), 'zh-Hans-CN'),
  )
  const now = new Date().toISOString()
  const job: ExportJob = {
    id: `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    filename:
      kind === 'csv'
        ? '盾构机台账-清单.csv'
        : '盾构机退场资料包.stpkg',
    machineIds: snapshot.map((row) => Number(row.id)),
    cursor: 0,
    total: snapshot.length,
    status: 'running',
    lines: [],
    startedAt: now,
    updatedAt: now,
  }
  saveJob(job)
  return job
}

export function getJob(id: string): ExportJob | undefined {
  return loadJobs()[id]
}

export function listJobs(): ExportJob[] {
  return Object.values(loadJobs()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

// 推一批：从检查点继续。failAt 用来演练中断（打完第 failAt 台后抛错），
// 此时任务标成 interrupted，已打台数落盘，重来时从下一台接着打。
export type PumpOptions = {
  batchSize?: number
  failAt?: number
}

export type PumpResult = {
  job: ExportJob
  interrupted: boolean
  finished: boolean
}

export function pumpExport(jobId: string, options: PumpOptions = {}): PumpResult {
  const batchSize = Math.max(1, options.batchSize ?? 50)
  // 每次都从事务后的最新存储装载作业，避免上层拿着旧对象续打。
  const job = loadJobs()[jobId]
  if (!job) {
    throw new Error('导出任务不存在，可能已被清理')
  }
  if (job.status === 'done') {
    return { job, interrupted: false, finished: true }
  }  const archiveById = new Map(selectShieldArchive().map((row) => [Number(row.id), row]))
  let processed = 0
  try {
    while (job.cursor < job.machineIds.length) {
      // 本批配额用完就收；但全局断点就在前方时，跨批也要走到那台再断。
      const reachFailPoint =
        options.failAt !== undefined &&
        job.cursor < options.failAt &&
        options.failAt <= job.machineIds.length
      if (processed >= batchSize && !reachFailPoint) {
        break
      }
      const id = job.machineIds[job.cursor]
      const machine = archiveById.get(id)
      if (machine) {
        job.lines.push(machineCsvLine(machine))
      }
      job.cursor += 1
      processed += 1
      if (options.failAt !== undefined && job.cursor === options.failAt) {
        throw new Error('导出在第 ' + job.cursor + ' 台处中断')
      }
    }
  } catch (error) {
    // 断在这台之前的台数都已在上面入列并随检查点落盘：不回滚已完成部分，也不生成半截文件。
    job.status = 'interrupted'
    job.updatedAt = new Date().toISOString()
    saveJob(job)
    return {
      job,
      interrupted: true,
      finished: false,
    }
  }
  if (job.cursor >= job.machineIds.length) {
    job.status = 'done'
  } else {
    job.status = 'running'
  }
  job.updatedAt = new Date().toISOString()
  saveJob(job)
  return { job, interrupted: false, finished: job.status === 'done' }
}

// FNV-1a：打包清单里给文件内容打个校验指纹，收件方能核对半包/错行。
function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

function buildCsv(job: ExportJob): string {
  return `﻿${[headerLine(), ...job.lines].join('\n')}`
}

// 打包：档案 CSV + 掘进环次待办对齐清单 + 对账 manifest，台数三处对得上才封口。
function buildPackage(job: ExportJob): string {
  const csvBody = [headerLine(), ...job.lines].join('\n')
  const archiveById = new Map(selectShieldArchive().map((row) => [Number(row.id), row]))
  const alignRows = [
    ['盾构机编号', '设备状态', '未闭环环次数', '退场结论'].map(csvCell).join(','),
  ]
  for (const id of job.machineIds) {
    const machine = archiveById.get(id)
    if (!machine) {
      continue
    }
    const pending = pendingRingsFor(String(machine.盾构机编号))
    const conclusion =
      pending.length === 0 ? '符合退场条件' : '存在未闭环掘进环次，不符合退场条件'
    alignRows.push(
      [machine.盾构机编号, machine.status, pending.length, conclusion].map(csvCell).join(','),
    )
  }
  const unassigned = unassignedPendingRings()
  const manifest = [
    'manifest: shield-exit-package v1',
    `generatedAt: ${new Date().toISOString()}`,
    `machineCount: ${job.machineIds.length}`,
    `csvChecksum: ${fnv1a(csvBody)}`,
    `alignmentChecksum: ${fnv1a(alignRows.join('\n'))}`,
    `unassignedPendingRings: ${unassigned.length}`,
  ].join('\n')
  return [
    'STPKG/1',
    `name=archive.csv`,
    `checksum=${fnv1a(csvBody)}`,
    '',
    csvBody,
    '---PART---',
    'name=ring-alignment.csv',
    `checksum=${fnv1a(alignRows.join('\n'))}`,
    '',
    alignRows.join('\n'),
    '---PART---',
    'name=manifest.txt',
    `checksum=${fnv1a(manifest)}`,
    '',
    manifest,
  ].join('\n')
}

// 只有打完整份才取得到内容；中途断掉返回 null，调用方不许触发下载。
export function exportJobContent(job: ExportJob): { filename: string; content: string; mime: string } | null {
  if (job.status !== 'done' || job.cursor !== job.machineIds.length) {
    return null
  }
  if (job.kind === 'csv') {
    return { filename: job.filename, content: buildCsv(job), mime: 'text/csv;charset=utf-8' }
  }
  return { filename: job.filename, content: buildPackage(job), mime: 'application/octet-stream' }
}

export function downloadJob(job: ExportJob): boolean {
  const file = exportJobContent(job)
  if (!file) {
    return false
  }
  const blob = new Blob([file.content], { type: file.mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = file.filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  return true
}

// 兼容旧入口的一把梭导出：直接跑完整份再下载，内部仍走同一计划/检查点管线。
export function runExportToCompletion(kind: ExportKind, filters: Record<string, string> = {}): ExportJob {
  const job = createExportJob(kind, filters)
  const result = pumpExport(job.id, { batchSize: Number.MAX_SAFE_INTEGER })
  if (result.interrupted || !result.finished) {
    throw new Error('导出未完成，已保留检查点，可从断点继续')
  }
  return result.job
}
