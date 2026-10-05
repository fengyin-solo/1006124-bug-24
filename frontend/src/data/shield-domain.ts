import { getStore, listRows, mutate } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

// 盾构机设备档案域：列表、导出、打包只准走这一份档案，其他入口（看板等）的台数也从这里算。
// 存量数据（旧台账、下载件、补录件）在首次读取时对账合并进档案，合并只跑一次且幂等。

export const SHIELD_KEY = 'shield'
export const RING_KEY = 'ring'

export const SHIELD_FIELDS = [
  '盾构机编号',
  '盾构机型号',
  '开挖直径',
  '刀盘形式',
  '总推力',
  '进场日期',
  '维保单位',
  '设备状态',
] as const

export const SHIELD_STATUSES = ['待进场', '调试中', '掘进中', '已退场'] as const
const STATUS_RANK: Record<string, number> = { 待进场: 0, 调试中: 1, 掘进中: 2, 已退场: 3 }
// 掘进环次里还算「待办」的状态：待掘进 / 掘进中；已贯通、已纠偏是已闭环。
const PENDING_RING_STATUSES = ['待掘进', '掘进中']

// 维保单位写法只留一种：统一以工商全称为准，旧台账里的简称/俗称归并到全称。
const MAINTAINER_CANONICAL: { full: string; aliases: string[] }[] = [
  {
    full: '中铁工程装备集团技术服务有限公司',
    aliases: ['中铁装备技服', '中铁装备技术服务', '中铁装备', '装备集团技服公司', '中铁工程装备技术服务'],
  },
  {
    full: '中铁十四局集团设备租赁有限公司',
    aliases: ['十四局设备租赁', '中铁十四局租赁', '十四局租赁公司', '中铁十四局设备租赁'],
  },
  {
    full: '上海隧道工程有限公司机械制造分公司',
    aliases: ['上海隧道机械', '上海隧道机施', '隧道股份机械厂'],
  },
  {
    full: '辽宁三三工业有限公司维保分公司',
    aliases: ['三三工业维保', '三三工业', '辽宁三三'],
  },
]

export function canonicalMaintainer(raw: unknown): string {
  const text = String(raw ?? '').trim()
  if (!text) {
    return ''
  }
  for (const entry of MAINTAINER_CANONICAL) {
    if (text === entry.full || entry.aliases.includes(text)) {
      return entry.full
    }
  }
  // 不认识的写法不瞎归并：原样保留，避免把两家并成一家。
  return text
}

// 进场日期统一算法：以设备档案的 进场日期 字段为准（其次回落到台账补录标记位），
// 兼容存量的多种读法：yyyy/M/d、yyyy年M月d日、yyyy.M.d、Date 可解析串、带时间的。
// 认不出来就返回空串，由调用方决定展示成什么，绝不伪造一个日期。
export function normalizeEntryDate(raw: unknown): string {
  const text = String(raw ?? '').trim()
  if (!text) {
    return ''
  }
  const matched = text.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/)
  let year = 0
  let month = 0
  let day = 0
  if (matched) {
    year = Number(matched[1])
    month = Number(matched[2])
    day = Number(matched[3])
  } else {
    const parsed = new Date(text)
    if (!Number.isNaN(parsed.getTime())) {
      year = parsed.getFullYear()
      month = parsed.getMonth() + 1
      day = parsed.getDate()
    }
  }
  if (!year || month < 1 || month > 12 || day < 1 || day > 31) {
    return ''
  }
  const padded = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  // 再验一次真实日历（2 月 30 日会被 Date 进位成 3 月 2 日，必须比对回来）。
  const reparsed = new Date(`${padded}T00:00:00`)
  const valid =
    reparsed.getFullYear() === year &&
    reparsed.getMonth() + 1 === month &&
    reparsed.getDate() === day
  return valid ? padded : ''
}

function textOf(row: EntryRow, ...keys: string[]): string {
  for (const key of keys) {
    const value = String(row[key] ?? '').trim()
    if (value) {
      return value
    }
  }
  return ''
}

function isBackfilled(row: EntryRow): boolean {
  return Boolean(row.补录) || String(row.记录来源 ?? '').includes('补录')
}

// —— 存量对账 ——

type LegacyGroup = {
  code: string
  rows: EntryRow[]
}

function groupLegacyShield(rows: EntryRow[]): LegacyGroup[] {
  const map = new Map<string, EntryRow[]>()
  for (const row of rows) {
    const code = textOf(row, '盾构机编号')
    if (!code) {
      continue
    }
    const list = map.get(code)
    if (list) {
      list.push(row)
    } else {
      map.set(code, [row])
    }
  }
  return [...map.entries()].map(([code, groupRows]) => ({ code, rows: groupRows }))
}

// 同一条重复递两次只记一次：按盾构机编号归并；补录件与旧台账打架时，
// 日期以补录为准、状态以真实流转中最靠后的为准；缺失字段互相补齐。
function mergeGroup(group: LegacyGroup): EntryRow {
  const rows = [...group.rows].sort((a, b) => Number(a.id) - Number(b.id))
  const backfills = rows.filter(isBackfilled)
  const primary = rows.find((row) => !isBackfilled(row)) ?? rows[0]

  const dateOf = (row: EntryRow): string =>
    normalizeEntryDate(textOf(row, '进场日期', '补录进场日期', '入场日期', '进场时间'))
  const backfillDates = backfills.map(dateOf).filter(Boolean).sort()
  const otherDates = rows.filter((row) => !isBackfilled(row)).map(dateOf).filter(Boolean).sort()
  // 补录过进场日期的机器以补录件为准（多条补录矛盾时取最早到场日）；没有补录件才回落旧台账。
  const entryDate = (backfillDates.length ? backfillDates : otherDates)[0] ?? ''

  const statusCandidates = rows
    .map((row) => String(row.status ?? '').trim())
    .filter((status) => status in STATUS_RANK)
  const status = statusCandidates.length
    ? statusCandidates.sort((a, b) => STATUS_RANK[b] - STATUS_RANK[a])[0]
    : '待进场'

  const pickField = (field: string): string => {
    // 补录件优先于旧台账，旧记录里的空样例值（"盾构机台账样例X"）让位给真实值。
    const ordered = [...backfills, ...rows]
    for (const row of ordered) {
      const value = String(row[field] ?? '').trim()
      if (value && !/^盾构机台账样例\d*$/.test(value)) {
        return value
      }
    }
    return String(primary[field] ?? '').trim()
  }

  const maintainers = rows
    .map((row) => canonicalMaintainer(textOf(row, '维保单位')))
    .filter(Boolean)
  const maintainer = maintainers[0] ?? ''
  const inconsistentMaintainer = new Set(maintainers).size > 1

  const mergedIds = rows.map((row) => Number(row.id)).filter((id) => Number.isFinite(id))
  const merged: EntryRow = {
    id: Math.min(...mergedIds),
    status,
    pending: status !== '已退场',
    abnormal: rows.some((row) => Boolean(row.abnormal)) || inconsistentMaintainer,
    盾构机编号: group.code,
    盾构机型号: pickField('盾构机型号'),
    开挖直径: pickField('开挖直径'),
    刀盘形式: pickField('刀盘形式'),
    总推力: pickField('总推力'),
    进场日期: entryDate,
    维保单位: maintainer,
    设备状态: status,
    补录: backfills.length ? '已并入补录件' : '',
    来源行: mergedIds.join(';'),
  }
  if (inconsistentMaintainer) {
    merged.归一说明 = '维保单位全称/简称并存，已统一为工商全称'
  }
  return merged
}

// 首次读取对账：旧台账 + 下载件 + 补录件合并成设备档案，版本号与数据在同一事务里提交。
// 已迁移过就直接返回，保证幂等；迁移本身在一个 mutate 事务里，失败整笔退回。
export function ensureShieldArchive(force = false): EntryRow[] {
  const store = getStore()
  if (!force && store.meta.shieldArchiveMigrated === true) {
    return store.entries[SHIELD_KEY] ?? []
  }
  return mutate((draft) => {
    if (!force && draft.meta.shieldArchiveMigrated === true) {
      return draft.entries[SHIELD_KEY] ?? []
    }
    const legacy = draft.entries[SHIELD_KEY] ?? []
    const archived = groupLegacyShield(legacy).map(mergeGroup)
    archived.sort((a, b) => String(a.盾构机编号).localeCompare(String(b.盾构机编号), 'zh-Hans-CN'))
    draft.entries[SHIELD_KEY] = archived
    draft.meta.shieldArchiveMigrated = true
    draft.schemaVersion = 2
    return archived
  })
}

// 唯一取数口：列表、导出、打包、看板统计都从这里拿档案，不允许各读一份。
export function selectShieldArchive(filters: Record<string, string> = {}): EntryRow[] {
  const archive = ensureShieldArchive()
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return archive
  }
  return archive.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

// —— 掘进环次待办对齐 ——

function ringMachineOf(row: EntryRow): string {
  return String(row['盾构机编号'] ?? '').trim()
}

export function pendingRingsFor(machineCode: string): EntryRow[] {
  return listRows(RING_KEY).filter(
    (row) => ringMachineOf(row) === machineCode && PENDING_RING_STATUSES.includes(String(row.status)),
  )
}

// 特殊情形：没挂到任何一台盾构机上的待办环，不卡任何一台机器退场，但要在页面上提示出来。
export function unassignedPendingRings(): EntryRow[] {
  const machineCodes = new Set(ensureShieldArchive().map((row) => String(row.盾构机编号)))
  return listRows(RING_KEY).filter(
    (row) =>
      PENDING_RING_STATUSES.includes(String(row.status)) &&
      (!ringMachineOf(row) || !machineCodes.has(ringMachineOf(row))),
  )
}

export type ExitVerdict =
  | { ok: true; conclusion: '符合退场条件'; pendingCount: 0; pendingRings: EntryRow[] }
  | {
      ok: false
      conclusion: '存在未闭环掘进环次，不符合退场条件'
      pendingCount: number
      pendingRings: EntryRow[]
    }

// 退场结论与掘进环次待办清单对齐：以服务端（本地域层）核算为准，页面传结论也只作展示。
export function evaluateExit(id: number): ExitVerdict {
  const archive = ensureShieldArchive()
  const machine = archive.find((row) => Number(row.id) === id)
  if (!machine) {
    return {
      ok: false,
      conclusion: '存在未闭环掘进环次，不符合退场条件',
      pendingCount: 0,
      pendingRings: [],
    }
  }
  const pendingRings = pendingRingsFor(String(machine.盾构机编号))
  if (pendingRings.length > 0) {
    return {
      ok: false,
      conclusion: '存在未闭环掘进环次，不符合退场条件',
      pendingCount: pendingRings.length,
      pendingRings,
    }
  }
  return { ok: true, conclusion: '符合退场条件', pendingCount: 0, pendingRings: [] }
}

// —— 权限 ——

// 能改开挖直径的只有设备管理员；值班员/访客越权提交一律挡回。
const DIAMETER_EDITOR_ROLES = ['设备管理员']

export type SessionLike = { role?: string }

export function canEditDiameter(session?: SessionLike | null): boolean {
  return DIAMETER_EDITOR_ROLES.includes(String(session?.role ?? ''))
}

// —— 写操作（全部走事务，失败整笔退回） ——

function fail(message: string): { ok: false; message: string } {
  return { ok: false, message }
}

function findMachine(rows: EntryRow[], id: number): EntryRow | undefined {
  return rows.find((row) => Number(row.id) === id)
}

function persist(machine: EntryRow): void {
  // 归档值统一一遍：维保单位只存全称，进场日期只存 yyyy-MM-dd，设备状态跟状态位一致。
  machine.维保单位 = canonicalMaintainer(machine.维保单位)
  machine.进场日期 = normalizeEntryDate(machine.进场日期)
  machine.设备状态 = String(machine.status)
  machine.pending = String(machine.status) !== '已退场'
}

export type DomainResult = { ok: boolean; message: string; conclusion?: string }

export function submitShieldExit(id: number): DomainResult {
  const verdict = evaluateExit(id)
  if (!verdict.ok) {
    const ringNos = verdict.pendingRings
      .map((ring) => String(ring.环号 ?? ring.id))
      .join('、')
    return fail(
      `退场被挡回：${verdict.conclusion}（待办 ${verdict.pendingCount} 环：${ringNos}），请先在掘进环次里闭环`,
    )
  }
  return mutate((draft) => {
    const rows = draft.entries[SHIELD_KEY] ?? []
    const machine = findMachine(rows, id)
    if (!machine) {
      return fail(`没有找到编号为 ${id} 的盾构机`)
    }
    if (String(machine.status) === '已退场') {
      // 同一条退场重复递两次只记一次。
      return { ok: true, message: `${machine.盾构机编号} 已退场，重复提交未重复记账`, conclusion: '符合退场条件' }
    }
    machine.status = '已退场'
    persist(machine)
    return { ok: true, message: `${machine.盾构机编号} 已办理退场：${verdict.conclusion}`, conclusion: verdict.conclusion }
  })
}

// 补录进场日期：以设备档案为准写回标准化日期。
export function backfillEntryDate(id: number, rawDate: string): DomainResult {
  const normalized = normalizeEntryDate(rawDate)
  if (!normalized) {
    return fail('进场日期无法识别，请按 yyyy-MM-dd 填写')
  }
  return mutate((draft) => {
    const rows = draft.entries[SHIELD_KEY] ?? []
    const machine = findMachine(rows, id)
    if (!machine) {
      return fail(`没有找到编号为 ${id} 的盾构机`)
    }
    if (String(machine.进场日期) === normalized) {
      // 同一条补录重复递两次只记一次，写不成就别落半条。
      return { ok: true, message: `${machine.盾构机编号} 的进场日期已是 ${normalized}，重复提交未重复记账` }
    }
    machine.进场日期 = normalized
    machine.补录 = machine.补录 ? String(machine.补录) : '已补录进场日期'
    persist(machine)
    return { ok: true, message: `${machine.盾构机编号} 进场日期已补录为 ${normalized}` }
  })
}

// 退场与补录落在同一个事务里：两边都过才提交，任一边写不成就整笔退回。
export function submitExitWithBackfill(
  id: number,
  rawDate: string,
): DomainResult {
  const normalized = normalizeEntryDate(rawDate)
  if (!normalized) {
    return fail('整笔退回：进场日期无法识别，请按 yyyy-MM-dd 填写')
  }
  const verdict = evaluateExit(id)
  if (!verdict.ok) {
    const ringNos = verdict.pendingRings.map((ring) => String(ring.环号 ?? ring.id)).join('、')
    return fail(
      `整笔退回：${verdict.conclusion}（待办 ${verdict.pendingCount} 环：${ringNos}），补录未落账`,
    )
  }
  return mutate((draft) => {
    const rows = draft.entries[SHIELD_KEY] ?? []
    const machine = findMachine(rows, id)
    if (!machine) {
      return fail(`整笔退回：没有找到编号为 ${id} 的盾构机`)
    }
    const alreadyExited = String(machine.status) === '已退场'
    const sameDate = String(machine.进场日期) === normalized
    if (alreadyExited && sameDate) {
      return { ok: true, message: `${machine.盾构机编号} 退场与补录均已是该状态，重复提交只记一次`, conclusion: '符合退场条件' }
    }
    machine.进场日期 = normalized
    machine.补录 = machine.补录 ? String(machine.补录) : '已补录进场日期'
    machine.status = '已退场'
    persist(machine)
    return {
      ok: true,
      message: `同一事务完成：${machine.盾构机编号} 进场日期补录为 ${normalized} 并办理退场（${verdict.conclusion}）`,
      conclusion: verdict.conclusion,
    }
  })
}

// 改开挖直径：已退场的设备不许再改；非设备管理员越权提交挡回去。
export function updateDiameter(
  id: number,
  diameter: string,
  session?: SessionLike | null,
): DomainResult {
  const value = String(diameter ?? '').trim()
  if (!value) {
    return fail('开挖直径不能为空')
  }
  if (!canEditDiameter(session)) {
    return fail(`越权操作被挡回：当前角色「${String(session?.role || '未登录')}」无权修改开挖直径，仅设备管理员可改`)
  }
  return mutate((draft) => {
    const rows = draft.entries[SHIELD_KEY] ?? []
    const machine = findMachine(rows, id)
    if (!machine) {
      return fail(`没有找到编号为 ${id} 的盾构机`)
    }
    if (String(machine.status) === '已退场') {
      return fail(`${machine.盾构机编号} 已退场，设备档案已封存，开挖直径不许再改`)
    }
    if (String(machine.开挖直径) === value) {
      return { ok: true, message: '开挖直径未变化，重复提交只记一次' }
    }
    machine.开挖直径 = value
    persist(machine)
    return { ok: true, message: `${machine.盾构机编号} 开挖直径已更新为 ${value}` }
  })
}

// 档案内的状态流转（办理进场、开始调试）：不涉及退场结论的普通动作。
export function advanceShieldStatus(id: number, action: '办理进场' | '开始调试'): DomainResult {
  const target = action === '办理进场' ? '调试中' : '掘进中'
  return mutate((draft) => {
    const rows = draft.entries[SHIELD_KEY] ?? []
    const machine = findMachine(rows, id)
    if (!machine) {
      return fail(`没有找到编号为 ${id} 的盾构机`)
    }
    if (String(machine.status) === '已退场') {
      return fail(`${machine.盾构机编号} 已退场，档案已封存，不能再${action}`)
    }
    if (String(machine.status) === target) {
      return { ok: true, message: `${machine.盾构机编号} 已经是「${target}」，重复操作未重复记账` }
    }
    machine.status = target
    persist(machine)
    return { ok: true, message: `${machine.盾构机编号} 已${action}，当前状态「${target}」` }
  })
}

// —— 统计：所有入口共用同一份取数，台数必须对得上 ——

export type ShieldStats = {
  total: number
  onSite: number
  boring: number
  pendingMaintenance: number
  exited: number
}

export function shieldStats(): ShieldStats {
  const archive = ensureShieldArchive()
  return {
    total: archive.length,
    onSite: archive.filter((row) => ['调试中', '掘进中'].includes(String(row.status))).length,
    boring: archive.filter((row) => String(row.status) === '掘进中').length,
    // 待维保：维保单位缺失，或档案里带着异常/待核标记的在场设备。
    pendingMaintenance: archive.filter(
      (row) =>
        String(row.status) !== '已退场' &&
        (!String(row.维保单位 ?? '').trim() || Boolean(row.abnormal)),
    ).length,
    exited: archive.filter((row) => String(row.status) === '已退场').length,
  }
}
