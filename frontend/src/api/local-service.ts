import { MODULE_BY_KEY } from '@/data/modules'
import {
  allRows,
  commitShieldArchive,
  listRows,
  resetRows,
  saveRows,
  shieldArchiveUpdatedAt,
  shieldRows,
} from '@/data/local-store'
import {
  RETIRE_CONCLUSION_FIELD,
  SHIELD_ARCHIVE_FIELDS,
  SHIELD_KEY,
  ShieldRuleError,
  assertFieldEditable,
  normalizeRow,
  prepareRetire,
  sortArchiveByEntryDate,
  upsertShield,
  type ShieldUpsertInput,
} from '@/data/shield-archive'
import {
  advanceExport,
  cancelExport,
  currentExportSession,
  startExport,
} from '@/data/shield-export'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  return meta ?? throwMissingModule(key)
}

function throwMissingModule(key: string): ModuleMeta {
  throw new Error(`没有登记名为 ${key} 的业务模块`)
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

/**
 * 列表取数：盾构机只认设备档案这一份；其余模块照旧读各自台账。
 * 导出、打包、看板台数共用同一取数口，两个入口读到的台数必然一致。
 */
export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const source = key === SHIELD_KEY ? shieldRows() : listRows(key)
  const matched = filterRows(source, filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export type ActionOptions = {
  /** 办理进场/退场时一并补录的进场日期，与状态流转落在同一个事务里。 */
  进场日期?: string
  /** 历史环次没挂盾构机编号时，显式确认按无主待办人工核销。 */
  确认无主待办?: boolean
}

export function runAction(key: string, id: number, action: string, options: ActionOptions = {}): ActionResult {
  if (key === SHIELD_KEY) {
    return runShieldAction(id, action, options)
  }
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

function runShieldAction(id: number, action: string, options: ActionOptions): ActionResult {
  if (action === '办理退场') {
    return retireShield(id, options)
  }
  if (action === '办理进场') {
    // 进场与补录日期同一事务：一次提交要么都成，要么整笔退回。
    try {
      const { items } = commitShieldArchive((draft) => {
        const row = draft.find((item) => Number(item.id) === id)
        if (!row) {
          throw new ShieldRuleError(`设备档案里没有编号为 ${id} 的盾构机`)
        }
        const next = normalizeRow(row)
        if (options.进场日期 && options.进场日期.trim()) {
          const normalized = normalizeRow({ ...next, 进场日期: options.进场日期 })
          if (!normalized['进场日期']) {
            throw new ShieldRuleError(`补录进场日期「${options.进场日期}」无法识别，请用 YYYY-MM-DD 写法`)
          }
          next['进场日期'] = normalized['进场日期']
        }
        if (next.status === '调试中') {
          throw new ShieldRuleError(`${next['盾构机编号']} 已办理过进场，重复提交只记一次`)
        }
        if (next.status !== '待进场') {
          // 掘进中/已退场都不允许往回拨状态，越权流转直接挡回。
          throw new ShieldRuleError(`${next['盾构机编号']} 当前是「${next.status}」，不能再办理进场`)
        }
        next.status = '调试中'
        next.pending = true
        return sortArchiveByEntryDate(
          draft.map((item) => (Number(item.id) === id ? next : item)),
        )
      })
      const row = items.find((item) => Number(item.id) === id)
      return {
        ok: true,
        message: `${row?.['盾构机编号'] ?? '盾构机'}已办理进场${options.进场日期 ? `，进场日期已按设备档案统一为 ${row?.['进场日期']}` : ''}`,
      }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '办理进场失败，已整笔退回' }
    }
  }
  if (action === '开始调试') {
    return genericShieldTransition(id, '掘进中', action)
  }
  return { ok: false, message: `盾构机没有登记「${action}」这个动作` }
}

function genericShieldTransition(id: number, target: '掘进中', action: string): ActionResult {
  try {
    commitShieldArchive((draft) => {
      const row = draft.find((item) => Number(item.id) === id)
      if (!row) {
        throw new ShieldRuleError(`设备档案里没有编号为 ${id} 的盾构机`)
      }
      const next = normalizeRow(row)
      if (next.status === target) {
        throw new ShieldRuleError(`${next['盾构机编号']}已经是「${target}」，重复提交只记一次`)
      }
      if (next.status === '已退场') {
        throw new ShieldRuleError(`${next['盾构机编号']} 已退场，不能再执行「${action}」`)
      }
      next.status = target
      next.pending = true
      return draft.map((item) => (Number(item.id) === id ? next : item))
    })
    return { ok: true, message: `盾构机已${action}，当前状态「${target}」` }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : `${action}失败，已整笔退回` }
  }
}

function retireShield(id: number, options: ActionOptions): ActionResult {
  try {
    const rings = listRows('ring')
    const { items } = commitShieldArchive((draft) => {
      // 退场结论与掘进环次待办清单在同一事务里核对，写不成就整笔退回。
      const plan = prepareRetire(draft, id, rings, {
        backfillDate: options.进场日期,
        confirmUnattributed: options.确认无主待办,
        today: today(),
      })
      if (plan.idempotent) {
        throw new ShieldRuleError(`${plan.row['盾构机编号']} 已退场，重复提交只记一次`)
      }
      return draft.map((item) => (Number(item.id) === id ? plan.row : item))
    })
    const row = items.find((item) => Number(item.id) === id)
    return {
      ok: true,
      message: `${row?.['盾构机编号']} 已办理退场：${row?.[RETIRE_CONCLUSION_FIELD]}`,
    }
  } catch (error) {
    if (error instanceof ShieldRuleError) {
      return { ok: false, message: error.message }
    }
    return { ok: false, message: '退场事务写入失败，退场与补录已整笔退回' }
  }
}

function today(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * 补录进场日期（设备部补录入口）：同一条重复递两次只记一次，写不成就不落半条。
 * 与退场共用同一事务通道。
 */
export function backfillShieldEntry(input: ShieldUpsertInput): ActionResult & { duplicated?: boolean } {
  try {
    let duplicated = false
    const { items } = commitShieldArchive((draft) => {
      const result = upsertShield(draft, input)
      duplicated = result.duplicated
      const code = String(result.row['盾构机编号'])
      const replaced = draft.some((item) => String(item['盾构机编号']) === code)
        ? draft.map((item) => (String(item['盾构机编号']) === code ? result.row : item))
        : [...draft, result.row]
      // 存量设备按进场日期重新过一遍，保持档案唯一排序口径。
      return sortArchiveByEntryDate(replaced)
    })
    const code = String(input.盾构机编号 ?? '').trim().toUpperCase()
    const row = items.find((item) => String(item['盾构机编号']) === code)
    return {
      ok: true,
      duplicated,
      message: duplicated
        ? `设备档案已有 ${code}，重复提交只记一次，新补录内容已并入原档（进场日期 ${row?.['进场日期'] || '待补'}）`
        : `设备档案已按统一算法登记：${code}，进场日期 ${row?.['进场日期'] || '待补'}`,
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '补录失败，未写入任何记录' }
  }
}

/** 修改设备档案字段；退场后的开挖直径在这里被锁死，越权提交直接挡回。 */
export function updateShieldField(id: number, field: string, value: string): ActionResult {
  try {
    commitShieldArchive((draft) => {
      const row = draft.find((item) => Number(item.id) === id)
      if (!row) {
        throw new ShieldRuleError(`设备档案里没有编号为 ${id} 的盾构机`)
      }
      assertFieldEditable(row, field)
      const next = normalizeRow({ ...row, [field]: value })
      return draft.map((item) => (Number(item.id) === id ? next : item))
    })
    return { ok: true, message: `盾构机「${field}」已更新` }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '修改失败，已整笔退回' }
  }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

function csvCell(value: unknown): string {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** 盾构机清单：列表/导出/打包共用的字段口径，以设备档案为准。 */
function shieldCsv(): string {
  const header = ['编号', ...SHIELD_ARCHIVE_FIELDS, '当前状态']
  const lines = [header.map(csvCell).join(',')]
  for (const row of shieldRows()) {
    lines.push(
      [row.id, ...SHIELD_ARCHIVE_FIELDS.map((field) => row[field] ?? ''), row.status]
        .map(csvCell)
        .join(','),
    )
  }
  return `\uFEFF${lines.join('\n')}`
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  if (key === SHIELD_KEY) {
    return { filename: `${meta.name}-清单.csv`, content: shieldCsv() }
  }
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.map(csvCell).join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].map(csvCell).join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export type ShieldDownloadResult = {
  filename: string
  content: string
  resumed: boolean
  exportedCount: number
  total: number
  message: string
}

/**
 * 导出盾构机台账清单：走断点会话。中断后再次调用会从断掉的那台接着打，
 * 全部打完才生成文件内容，任何中断都不会留下半包文件。
 */
export function downloadShieldEntries(): ShieldDownloadResult {
  const items = shieldRows()
  const updatedAt = shieldArchiveUpdatedAt()
  const existing = currentExportSession(items, updatedAt)
  let resumed = false
  if (existing) {
    if (existing.doneIds.length >= items.length) {
      cancelExport()
    } else {
      resumed = true
    }
  } else {
    startExport(items, updatedAt)
  }
  // 循环推进断点直到全部打完；每一步都先落会话，出错时进度不丢。
  let guard = 0
  let result = advanceExport(items, updatedAt, 2)
  while (!result.finished) {
    if (guard++ > items.length + 2) {
      throw new Error('导出断点推进异常，已保留断点，可稍后从断掉的那台继续')
    }
    result = advanceExport(items, updatedAt, 2)
  }
  return {
    filename: '盾构机台账-清单.csv',
    content: shieldCsv(),
    resumed,
    exportedCount: items.length,
    total: items.length,
    message: resumed
      ? `检测到上次导出中断，已从断掉的那台续打完成，共 ${items.length} 台`
      : `盾构机台账清单导出完成，共 ${items.length} 台`,
  }
}

/** 导出断点进度（页面用来提示「上次打到第几台」）。 */
export function shieldExportProgress(): { done: number; total: number } | null {
  const items = shieldRows()
  const session = currentExportSession(items, shieldArchiveUpdatedAt())
  if (!session) {
    return null
  }
  return { done: session.doneIds.length, total: session.total }
}

export function cancelShieldExport(): void {
  cancelExport()
}

/** 打包：同样只从设备档案取数，和列表、导出台数一致。 */
export function packShieldArchive(): { filename: string; content: string } {
  const items = shieldRows()
  const bundle = {
    名称: '盾构机设备档案打包',
    导出口径: '设备档案（列表/导出/打包共用）',
    打包时间: new Date().toISOString(),
    台数: items.length,
    设备: items.map((row) => {
      const flat: Record<string, unknown> = { 编号: row.id, 当前状态: row.status }
      for (const field of SHIELD_ARCHIVE_FIELDS) {
        flat[field] = row[field] ?? ''
      }
      return flat
    }),
  }
  return {
    filename: `盾构机设备档案-${today()}.json`,
    content: JSON.stringify(bundle, null, 2),
  }
}

export function downloadEntries(key: string): void {
  if (key === SHIELD_KEY) {
    const result = downloadShieldEntries()
    triggerDownload(result.filename, result.content, 'text/csv;charset=utf-8')
    return
  }
  const { filename, content } = exportEntries(key)
  triggerDownload(filename, content, 'text/csv;charset=utf-8')
}

export function downloadPack(key: string): string {
  if (key !== SHIELD_KEY) {
    throw new Error('只有盾构机设备档案提供打包口')
  }
  const { filename, content } = packShieldArchive()
  triggerDownload(filename, content, 'application/json;charset=utf-8')
  return `设备档案已打包，共 ${shieldRows().length} 台`
}

function triggerDownload(filename: string, content: string, type: string): void {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export type ShieldStats = { label: string; value: number }[]

/** 盾构机看板指标，直接数设备档案；看板总览数的是同一份镜像，数字跟着重算。 */
export function shieldMetrics(): ShieldStats {
  const items = shieldRows()
  return [
    { label: '在场盾构机', value: items.filter((row) => ['调试中', '掘进中'].includes(String(row.status))).length },
    { label: '掘进中盾构机', value: items.filter((row) => String(row.status) === '掘进中').length },
    { label: '待维保盾构机', value: items.filter((row) => Boolean(row.abnormal)).length },
  ]
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    // shield 这一格是设备档案在通用台账里的镜像，与列表/导出/打包同源同口径。
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
