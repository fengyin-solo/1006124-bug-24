import type { EntryRow } from './types'

/**
 * 盾构机「设备档案」领域：列表、导出、打包三条读路全部只认这一份档案。
 * 这里只放纯规则（归一、去重、校验、退场结论），不碰 localStorage；
 * 落盘与跨表事务由 local-store 负责，编排在 local-service。
 */

export const SHIELD_KEY = 'shield'
export const RETIRE_CONCLUSION_FIELD = '退场结论'
export const BACKFILL_DATE_FIELD = '补录进场日期'

const FINAL_STATUS = '已退场'

// 设备档案对外的标准字段顺序（退场结论是档案补出来的）。
export const SHIELD_ARCHIVE_FIELDS = [
  '盾构机编号',
  '盾构机型号',
  '开挖直径',
  '刀盘形式',
  '总推力',
  '进场日期',
  '维保单位',
  '设备状态',
  RETIRE_CONCLUSION_FIELD,
]

const STATUS_RANK: Record<string, number> = {
  待进场: 0,
  调试中: 1,
  掘进中: 2,
  已退场: 3,
}
const STATUS_ALIAS: Record<string, string> = {
  已进场: '调试中',
  在场: '调试中',
}

function normalizeStatus(value: unknown): string {
  const text = String(value ?? '').trim()
  if (text in STATUS_RANK) {
    return text
  }
  return STATUS_ALIAS[text] ?? '待进场'
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * 进场日期统一算法：以设备档案上的日期为准，兼容历史记录的几种写法。
 * 支持 2026-08-12 / 2026/8/12 / 2026.8.12 / 2026年8月12日 / 20260812 / 带时间的 ISO，
 * 解析不出来就返回空串，由调用方决定是挡回还是按未知日期处理。
 */
export function normalizeEntryDate(value: unknown): string {
  if (value === null || value === undefined) {
    return ''
  }
  const text = String(value).trim()
  if (!text) {
    return ''
  }
  let match = text.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:\D.*)?$/)
  if (match) {
    return composeDate(Number(match[1]), Number(match[2]), Number(match[3]))
  }
  match = text.match(/^(\d{4})(\d{2})(\d{2})$/)
  if (match) {
    return composeDate(Number(match[1]), Number(match[2]), Number(match[3]))
  }
  const parsed = new Date(text)
  if (!Number.isNaN(parsed.getTime())) {
    return composeDate(parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate())
  }
  return ''
}

function composeDate(year: number, month: number, day: number): string {
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return ''
  }
  return `${year}-${pad2(month)}-${pad2(day)}`
}

// 维保单位只留一种写法：统一成全名，历史上各处的简称/别称都映到同一个全称。
export const MAINTAINER_FULL_NAME = '中铁工程装备集团技术服务有限公司'
const MAINTAINER_ALIASES = new Set([
  MAINTAINER_FULL_NAME,
  '中铁装备',
  '中铁装备维保',
  '中铁装备公司',
  '中铁装备技术服务',
  '中铁装备技术服务有限公司',
  '中铁工程装备集团技术服务公司',
  '装备维保分公司',
  '装备公司维保分公司',
])

export function normalizeMaintainer(value: unknown): string {
  const text = String(value ?? '').trim()
  if (!text) {
    return ''
  }
  // 去掉内部空白后再比对，兼容「中铁 装备」这类手误写法。
  const compact = text.replace(/\s+/g, '')
  for (const alias of MAINTAINER_ALIASES) {
    if (compact === alias.replace(/\s+/g, '')) {
      return MAINTAINER_FULL_NAME
    }
  }
  // 认识不了的单位（外单位维保）原样保留，不瞎改。
  return text
}

function pickText(row: EntryRow, field: string): string {
  return String(row[field] ?? '').trim()
}

/** 取设备档案认可的进场日期：补录过的日期优先，其次是原进场日期。 */
export function effectiveEntryDate(row: EntryRow): string {
  return normalizeEntryDate(row[BACKFILL_DATE_FIELD]) || normalizeEntryDate(row['进场日期'])
}

function dateScore(row: EntryRow): number {
  if (normalizeEntryDate(row[BACKFILL_DATE_FIELD])) {
    return 2
  }
  if (normalizeEntryDate(row['进场日期'])) {
    return 1
  }
  return 0
}

function machineCode(row: EntryRow): string {
  return pickText(row, '盾构机编号').toUpperCase()
}

export type DroppedDuplicate = { id: number; code: string; reason: string }

export type BuiltArchive = {
  items: EntryRow[]
  dropped: DroppedDuplicate[]
}

/**
 * 把旧通用台账里的盾构机记录整体过一遍，归一成设备档案：
 * - 同一盾构机编号的多条记录只留一条（补录过进场日期的优先，旧记录丢弃）；
 * - 进场日期统一算法、维保单位统一全称；
 * - 存量设备按进场日期重新排序。
 */
export function buildShieldArchive(legacyRows: EntryRow[]): BuiltArchive {
  const dropped: DroppedDuplicate[] = []
  const groups = new Map<string, EntryRow[]>()
  const standalone: EntryRow[] = []

  for (const row of legacyRows) {
    const code = machineCode(row)
    if (!code) {
      standalone.push(normalizeRow(row))
      continue
    }
    const list = groups.get(code)
    if (list) {
      list.push(row)
    } else {
      groups.set(code, [row])
    }
  }

  const merged: EntryRow[] = []
  for (const [code, members] of groups) {
    const primary = pickPrimary(members)
    if (members.length > 1) {
      for (const member of members) {
        if (member.id !== primary.id) {
          dropped.push({ id: Number(member.id), code, reason: '同编号重复旧记录，已按设备档案去重' })
        }
      }
    }
    merged.push(mergeMembers(code, primary, members.filter((member) => member.id !== primary.id)))
  }

  const items = [...merged, ...standalone].sort((a, b) => compareByEntryDate(a, b))
  return { items, dropped }
}

function pickPrimary(members: EntryRow[]): EntryRow {
  return [...members].sort((a, b) => {
    const byScore = dateScore(b) - dateScore(a)
    if (byScore !== 0) {
      return byScore
    }
    const byStatus = STATUS_RANK[normalizeStatus(b.status)] - STATUS_RANK[normalizeStatus(a.status)]
    if (byStatus !== 0) {
      return byStatus
    }
    // 同分时保留最早入库的那条，行为稳定。
    return Number(a.id) - Number(b.id)
  })[0]
}

function mergeMembers(code: string, primary: EntryRow, others: EntryRow[]): EntryRow {
  const merged = normalizeRow(primary)
  for (const other of [...others].sort((a, b) => Number(a.id) - Number(b.id))) {
    const candidate = normalizeRow(other)
    for (const field of ['盾构机型号', '开挖直径', '刀盘形式', '总推力', '设备状态']) {
      if (!pickText(merged, field) && pickText(candidate, field)) {
        merged[field] = candidate[field]
      }
    }
    if (!pickText(merged, '维保单位') && pickText(candidate, '维保单位')) {
      merged['维保单位'] = candidate['维保单位']
    }
    if (!effectiveEntryDate(merged) && effectiveEntryDate(candidate)) {
      merged['进场日期'] = effectiveEntryDate(candidate)
    }
    if (!pickText(merged, RETIRE_CONCLUSION_FIELD) && pickText(candidate, RETIRE_CONCLUSION_FIELD)) {
      merged[RETIRE_CONCLUSION_FIELD] = candidate[RETIRE_CONCLUSION_FIELD]
    }
  }
  merged['盾构机编号'] = code
  // 状态取同编号记录里最新的，pending/异常标记按归一后的状态重算。
  const newest = [primary, ...others].sort(
    (a, b) => STATUS_RANK[normalizeStatus(b.status)] - STATUS_RANK[normalizeStatus(a.status)],
  )[0]
  merged.status = normalizeStatus(newest.status)
  merged.pending = merged.status !== FINAL_STATUS
  // 存量的异常标记不能在重新归一时被洗掉：同编号任一条挂过异常就保留，已退场则清掉。
  merged.abnormal = merged.status === FINAL_STATUS
    ? false
    : [primary, ...others].some((member) => Boolean(member.abnormal))
  if (merged.status === FINAL_STATUS && !pickText(merged, RETIRE_CONCLUSION_FIELD)) {
    merged[RETIRE_CONCLUSION_FIELD] = '历史退场记录：退场结论待补录'
  }
  delete merged[BACKFILL_DATE_FIELD]
  return merged
}

function compareByEntryDate(a: EntryRow, b: EntryRow): number {
  const dateA = effectiveEntryDate(a)
  const dateB = effectiveEntryDate(b)
  if (!dateA && !dateB) {
    return Number(a.id) - Number(b.id)
  }
  if (!dateA) {
    return 1
  }
  if (!dateB) {
    return -1
  }
  if (dateA !== dateB) {
    return dateA < dateB ? -1 : 1
  }
  return Number(a.id) - Number(b.id)
}

/** 一条记录的字段归一：进场日期统一格式、维保单位统一全称、状态取合法值。 */
export function normalizeRow(row: EntryRow): EntryRow {
  const next: EntryRow = {
    ...row,
    '盾构机编号': pickText(row, '盾构机编号').toUpperCase(),
    '维保单位': normalizeMaintainer(row['维保单位']),
    status: normalizeStatus(row.status),
  }
  const entryDate = effectiveEntryDate(row) || normalizeEntryDate(row['进场日期'])
  next['进场日期'] = entryDate
  delete next[BACKFILL_DATE_FIELD]
  next.pending = next.status !== FINAL_STATUS
  if (next.status === FINAL_STATUS) {
    next.abnormal = false
  }
  return next
}

/** 设备档案里所有维保单位的写法（归一后应只剩全称一种，外加空值）。 */
export function distinctMaintainers(items: EntryRow[]): string[] {
  return [...new Set(items.map((row) => pickText(row, '维保单位')).filter(Boolean))].sort()
}

/** 存量设备按进场日期重新排序（统一口径，日期缺失的沉底）。 */
export function sortArchiveByEntryDate(items: EntryRow[]): EntryRow[] {
  return [...items].sort(compareByEntryDate)
}

export class ShieldRuleError extends Error {}

const PENDING_RING_STATUSES = new Set(['待掘进', '掘进中'])
const RING_SHIELD_FIELDS = ['盾构机编号', '盾构机', '设备编号', '对应盾构机', '盾构编号']

/**
 * 退场结论必须与掘进环次的待办清单对齐：
 * 环次上挂了盾构机编号就按编号核对；历史数据没挂编号时，退化为全部待办都算这台的，
 * 宁可挡回让人工确认，也不让结论与待办脱节。
 */
export function pendingRingsForShield(code: string, rings: EntryRow[]): EntryRow[] {
  const key = code.trim().toUpperCase()
  const attributed = rings.filter((row) =>
    RING_SHIELD_FIELDS.some((field) => String(row[field] ?? '').trim() !== ''),
  )
  const scope = attributed.length
    ? rings.filter((row) =>
        RING_SHIELD_FIELDS.some(
          (field) => String(row[field] ?? '').trim().toUpperCase() === key,
        ),
      )
    : rings
  return scope.filter((row) => PENDING_RING_STATUSES.has(String(row.status).trim()))
}

export function relatedRingCount(code: string, rings: EntryRow[]): number {
  const key = code.trim().toUpperCase()
  const attributed = rings.filter((row) =>
    RING_SHIELD_FIELDS.some((field) => String(row[field] ?? '').trim() !== ''),
  )
  if (!attributed.length) {
    return rings.length
  }
  return attributed.filter((row) =>
    RING_SHIELD_FIELDS.some(
      (field) => String(row[field] ?? '').trim().toUpperCase() === key,
    ),
  ).length
}

export type RetirePlan =
  | { idempotent: true; row: EntryRow }
  | { idempotent: false; row: EntryRow; unconfirmedUnattributed: number }

export type RetireOptions = {
  backfillDate?: string
  /** 历史环次没挂盾构机编号时，人工确认这些无主待办不由本机承担。 */
  confirmUnattributed?: boolean
  today?: string
}

/**
 * 退场预校验（不落数据）：掘进环次还有挂在本机名下的待办就挡回；允许带补录
 * 进场日期一起办，但日期写法必须能被统一算法认出来。
 * 历史环次没挂编号时，无主待办默认也先挡回（宁可多确认一次），人工确认后放行并在结论里注明。
 */
export function prepareRetire(
  items: EntryRow[],
  id: number,
  rings: EntryRow[],
  options: RetireOptions = {},
): RetirePlan {
  const { backfillDate, confirmUnattributed = false, today = todayIso() } = options
  const row = items.find((item) => Number(item.id) === id)
  if (!row) {
    throw new ShieldRuleError(`设备档案里没有编号为 ${id} 的盾构机`)
  }
  if (row.status === FINAL_STATUS) {
    return { idempotent: true, row }
  }
  const next = normalizeRow(row)
  if (backfillDate && backfillDate.trim() !== '') {
    const parsed = normalizeEntryDate(backfillDate)
    if (!parsed) {
      throw new ShieldRuleError(`补录进场日期「${backfillDate}」无法识别，请用 YYYY-MM-DD 写法`)
    }
    if (!next['进场日期']) {
      next['进场日期'] = parsed
    }
  }
  const code = pickText(next, '盾构机编号')
  const attributedRings = rings.filter((r) =>
    RING_SHIELD_FIELDS.some((field) => String(r[field] ?? '').trim() !== ''),
  )
  const unattributedPending =
    attributedRings.length === 0
      ? rings.filter((r) => PENDING_RING_STATUSES.has(String(r.status).trim())).length
      : 0
  const minePending = pendingRingsForShield(code, rings)

  if (minePending.length && (attributedRings.length > 0 || !confirmUnattributed)) {
    const ringNos = minePending.map((ring) => pickText(ring, '环号')).filter(Boolean).join('、')
    if (attributedRings.length > 0) {
      throw new ShieldRuleError(
        `退场申请与掘进环次待办清单不一致：${code} 还有 ${minePending.length} 环未闭环（${ringNos || '待办环次'}），已挡回`,
      )
    }
    throw new ShieldRuleError(
      `掘进环次清单有 ${minePending.length} 条待办未挂盾构机编号，无法确认归属（${ringNos || '待办环次'}）。确认不由 ${code} 承担后可再提交一次`,
    )
  }

  next.status = FINAL_STATUS
  next.pending = false
  const total = relatedRingCount(code, rings)
  const note =
    unattributedPending && confirmUnattributed
      ? `；另有 ${unattributedPending} 条历史无编号待办，已人工确认与本机无关`
      : ''
  next[RETIRE_CONCLUSION_FIELD] = `同意退场：关联掘进环已全部闭环（核对${total}环，挂名待办0项${note}），退场日期 ${today}`
  return { idempotent: false, row: next, unconfirmedUnattributed: unattributedPending }
}

function todayIso(): string {
  return normalizeEntryDate(new Date().toISOString())
}

/** 改字段前的权限校验：退场后的设备，开挖直径锁死，越权提交直接挡回。 */
export function assertFieldEditable(row: EntryRow, field: string): void {
  if (row.status === FINAL_STATUS && field === '开挖直径') {
    throw new ShieldRuleError(
      `${pickText(row, '盾构机编号')} 已退场，开挖直径已锁定，不允许再修改（越权提交已挡回）`,
    )
  }
}

export type ShieldUpsertInput = {
  id?: number
  盾构机编号?: string
  盾构机型号?: string
  开挖直径?: string
  刀盘形式?: string
  总推力?: string
  进场日期?: string
  维保单位?: string
  设备状态?: string
}

export type UpsertResult = { row: EntryRow; duplicated: boolean }

/**
 * 补录/登记入口：同一条（按盾构机编号）重复递两次只记一次。
 * 已存在就把新内容并进原档（补录的进场日期优先），不会新造一行。
 */
export function upsertShield(items: EntryRow[], input: ShieldUpsertInput): UpsertResult {
  const code = String(input.盾构机编号 ?? '').trim().toUpperCase()
  if (!code) {
    throw new ShieldRuleError('盾构机编号不能为空')
  }
  if (input.进场日期 && !normalizeEntryDate(input.进场日期)) {
    throw new ShieldRuleError(`进场日期「${input.进场日期}」无法识别，请用 YYYY-MM-DD 写法`)
  }
  const existing = items.find((row) => machineCode(row) === code)
  if (existing) {
    const merged = normalizeRow(existing)
    for (const field of ['盾构机型号', '刀盘形式', '总推力', '设备状态'] as const) {
      const value = String(input[field] ?? '').trim()
      if (value) {
        merged[field] = value
      }
    }
    if (input.开挖直径 !== undefined && input.开挖直径.trim() !== '') {
      assertFieldEditable(merged, '开挖直径')
      merged['开挖直径'] = input.开挖直径.trim()
    }
    if (input.维保单位 && input.维保单位.trim()) {
      merged['维保单位'] = normalizeMaintainer(input.维保单位)
    }
    const parsedDate = normalizeEntryDate(input.进场日期)
    if (parsedDate) {
      merged['进场日期'] = parsedDate
    }
    return { row: merged, duplicated: true }
  }
  if (input.id !== undefined && items.some((row) => Number(row.id) === input.id)) {
    throw new ShieldRuleError(`编号 ${input.id} 已被占用，补录失败`)
  }
  const id = input.id ?? nextId(items)
  const row = normalizeRow({
    id,
    status: '待进场',
    pending: true,
    abnormal: false,
    盾构机编号: code,
    盾构机型号: String(input.盾构机型号 ?? '').trim(),
    开挖直径: String(input.开挖直径 ?? '').trim(),
    刀盘形式: String(input.刀盘形式 ?? '').trim(),
    总推力: String(input.总推力 ?? '').trim(),
    进场日期: normalizeEntryDate(input.进场日期),
    维保单位: normalizeMaintainer(input.维保单位),
    设备状态: String(input.设备状态 ?? '').trim() || '完好',
  } as EntryRow)
  return { row, duplicated: false }
}

export function nextId(items: EntryRow[]): number {
  return items.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}
