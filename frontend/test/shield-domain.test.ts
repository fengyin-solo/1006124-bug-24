import { strict as assert } from 'node:assert'
import test from 'node:test'

import { resetRows, getStore } from '../src/data/local-store.ts'
import {
  advanceShieldStatus,
  backfillEntryDate,
  canonicalMaintainer,
  ensureShieldArchive,
  evaluateExit,
  normalizeEntryDate,
  pendingRingsFor,
  selectShieldArchive,
  shieldStats,
  submitExitWithBackfill,
  submitShieldExit,
  unassignedPendingRings,
  updateDiameter,
} from '../src/data/shield-domain.ts'
import {
  createExportJob,
  downloadJob,
  exportJobContent,
  getJob,
  pumpExport,
  runExportToCompletion,
} from '../src/data/export-pipeline.ts'
import { listEntries, loadOverview } from '../src/api/local-service.ts'

// localStorage 垫片：测试环境没有浏览器，local-store 会退到内存，但这里给个显式实现。
class MemoryStorage {
  private map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
  clear(): void {
    this.map.clear()
  }
}
;(globalThis as { window?: unknown; localStorage?: unknown }).window = {}
;(globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage()

// 每次用例都把盾构机与环次重置回种子（盾构机重置会顺带清迁移标记，强制重新对账）。
function reseed() {
  resetRows('ring')
  resetRows('shield')
}

test('维保单位全称/简称归一到工商全称', () => {
  assert.equal(canonicalMaintainer('中铁装备技服'), '中铁工程装备集团技术服务有限公司')
  assert.equal(canonicalMaintainer('中铁工程装备集团技术服务有限公司'), '中铁工程装备集团技术服务有限公司')
  assert.equal(canonicalMaintainer('十四局设备租赁'), '中铁十四局集团设备租赁有限公司')
  assert.equal(canonicalMaintainer('上海隧道机械'), '上海隧道工程有限公司机械制造分公司')
  assert.equal(canonicalMaintainer('某不知名单位'), '某不知名单位')
  assert.equal(canonicalMaintainer(''), '')
})

test('进场日期统一算法并兼容存量写法', () => {
  assert.equal(normalizeEntryDate('2026/3/5'), '2026-03-05')
  assert.equal(normalizeEntryDate('2026年03月06日'), '2026-03-06')
  assert.equal(normalizeEntryDate('2026.04.12'), '2026-04-12')
  assert.equal(normalizeEntryDate('2026-08-18 09:30'), '2026-08-18')
  assert.equal(normalizeEntryDate('2026-02-30'), '')
  assert.equal(normalizeEntryDate(''), '')
})

test('存量对账：旧台账+下载件+补录件按编号并成一台，重复只记一次', () => {
  reseed()
  const archive = ensureShieldArchive()
  const codes = archive.map((row) => String(row.盾构机编号))
  assert.deepEqual(codes, ['DG-001', 'DG-002', 'DG-003', 'DG-004', 'DG-005', 'DG-006'])
  assert.equal(archive.length, 6, '10 行存量记录应并成 6 台')

  const dg001 = archive.find((row) => row.盾构机编号 === 'DG-001')!
  // 补录过进场日期：以补录件为准。
  assert.equal(dg001.进场日期, '2026-03-06')
  // 维保单位只留全称。
  assert.equal(dg001.维保单位, '中铁工程装备集团技术服务有限公司')
  // 状态取流转中最靠后的。
  assert.equal(dg001.status, '掘进中')
  assert.equal(String(dg001.来源行), '1;2;3')
  assert.equal(dg001.盾构机型号, '土压平衡 EPB6250')

  // 迁移幂等：再跑一遍不增减。
  assert.equal(ensureShieldArchive().length, 6)
  assert.equal(getStore().schemaVersion, 2)
})

test('两个入口台数对得上：列表与看板同一份取数', () => {
  reseed()
  const listCount = listEntries('shield').total
  const overview = loadOverview()
  const shieldRow = overview.modules.find((item) => item.name === '盾构机台账')!
  const card = overview.cards.find((item) => item.label === '盾构机在册台数')!
  assert.equal(listCount, 6)
  assert.equal(shieldRow.created, 6)
  assert.equal(card.value, 6)
  assert.equal(shieldStats().total, 6)
})

test('筛选后的列表与导出仍是同一台数', () => {
  reseed()
  const filtered = selectShieldArchive({ 盾构机编号: 'DG-001' })
  assert.equal(filtered.length, 1)
  const job = runExportToCompletion('csv', { 盾构机编号: 'DG-001' })
  assert.equal(job.machineIds.length, 1)
  assert.equal(job.lines.length, 1)
})

test('退场结论与掘进环次待办清单对齐', () => {
  reseed()
  const archive = ensureShieldArchive()
  const dg001 = archive.find((row) => row.盾构机编号 === 'DG-001')!
  const dg005 = archive.find((row) => row.盾构机编号 === 'DG-005')!

  // DG-001 有一环掘进中，退场挡回。
  assert.equal(pendingRingsFor('DG-001').length, 1)
  const blocked = evaluateExit(Number(dg001.id))
  assert.equal(blocked.ok, false)
  assert.equal(blocked.pendingCount, 1)
  const blockedResult = submitShieldExit(Number(dg001.id))
  assert.equal(blockedResult.ok, false)
  assert.match(blockedResult.message, /R-002/)

  // DG-005 全部环次闭环，退场通过。
  assert.equal(evaluateExit(Number(dg005.id)).ok, true)
  const exited = submitShieldExit(Number(dg005.id))
  assert.equal(exited.ok, true)

  // 重复退场只记一次。
  const again = submitShieldExit(Number(dg005.id))
  assert.equal(again.ok, true)
  assert.match(again.message, /重复提交未重复记账/)

  // 未挂设备的待办环（R-900）不卡退场。
  assert.equal(unassignedPendingRings().length, 1)
})

test('补录进场日期：标准化、幂等、坏日期不落半条', () => {
  reseed()
  ensureShieldArchive()
  const dg004 = selectShieldArchive().find((row) => row.盾构机编号 === 'DG-004')!
  const ok = backfillEntryDate(Number(dg004.id), '2026/07/02')
  assert.equal(ok.ok, true)
  assert.equal(
    selectShieldArchive().find((row) => row.盾构机编号 === 'DG-004')!.进场日期,
    '2026-07-02',
  )
  const dup = backfillEntryDate(Number(dg004.id), '2026-07-02')
  assert.match(dup.message, /重复提交未重复记账/)
  const bad = backfillEntryDate(Number(dg004.id), 'not-a-date')
  assert.equal(bad.ok, false)
  assert.equal(
    selectShieldArchive().find((row) => row.盾构机编号 === 'DG-004')!.进场日期,
    '2026-07-02',
  )
})

test('退场+补录同一事务：环次未闭环时整笔退回，日期也不落账', () => {
  reseed()
  ensureShieldArchive()
  const dg002 = selectShieldArchive().find((row) => row.盾构机编号 === 'DG-002')!
  const before = String(dg002.进场日期)
  const result = submitExitWithBackfill(Number(dg002.id), '2026-04-15')
  assert.equal(result.ok, false)
  assert.match(result.message, /整笔退回/)
  const after = selectShieldArchive().find((row) => row.盾构机编号 === 'DG-002')!
  assert.equal(String(after.进场日期), before, '整笔退回：补录日期不许落账')
  assert.equal(after.status, '调试中', '整笔退回：退场状态不许落账')

  // 坏日期同样整笔退回。
  const badDate = submitExitWithBackfill(Number(dg002.id), '乱七八糟')
  assert.equal(badDate.ok, false)
})

test('开挖直径：越权挡回、已退场封存', () => {
  reseed()
  ensureShieldArchive()
  const dg001 = selectShieldArchive().find((row) => row.盾构机编号 === 'DG-001')!
  const dg005 = selectShieldArchive().find((row) => row.盾构机编号 === 'DG-005')!

  const denied = updateDiameter(Number(dg001.id), '7.00m', { role: '值班员' })
  assert.equal(denied.ok, false)
  assert.match(denied.message, /越权/)
  assert.equal(
    selectShieldArchive().find((row) => row.盾构机编号 === 'DG-001')!.开挖直径,
    '6.28m',
    '越权提交不得改动数据',
  )

  const allowed = updateDiameter(Number(dg001.id), '6.30m', { role: '设备管理员' })
  assert.equal(allowed.ok, true)
  assert.equal(
    selectShieldArchive().find((row) => row.盾构机编号 === 'DG-001')!.开挖直径,
    '6.30m',
  )

  // 先退场再改：即使是设备管理员也不许。
  assert.equal(submitShieldExit(Number(dg005.id)).ok, true)
  const sealed = updateDiameter(Number(dg005.id), '9.99m', { role: '设备管理员' })
  assert.equal(sealed.ok, false)
  assert.match(sealed.message, /已退场/)

  // 已退场设备不许再通过状态流转回流。
  const reflow = advanceShieldStatus(Number(dg005.id), '办理进场')
  assert.equal(reflow.ok, false)
  assert.match(reflow.message, /封存/)
})

test('退场+补录同一事务成功路径：一次提交两边都落账', () => {
  reseed()
  ensureShieldArchive()
  const dg005 = selectShieldArchive().find((row) => row.盾构机编号 === 'DG-005')!
  const result = submitExitWithBackfill(Number(dg005.id), '2025/11/09')
  assert.equal(result.ok, true)
  assert.match(result.message, /同一事务/)
  const after = selectShieldArchive().find((row) => row.盾构机编号 === 'DG-005')!
  assert.equal(after.进场日期, '2025-11-09')
  assert.equal(after.status, '已退场')

  // 整笔幂等：同样的请求再递一次只记一次。
  const again = submitExitWithBackfill(Number(dg005.id), '2025-11-09')
  assert.equal(again.ok, true)
  assert.match(again.message, /重复提交只记一次/)
})

test('导出中断后从断点续打，未完成不给文件，完成后台数一致', () => {
  reseed()
  const job = createExportJob('csv')
  assert.equal(job.total, 6)

  // 每批 2 台，打完第 3 台时中断。
  let result = pumpExport(job.id, { batchSize: 2, failAt: 3 })
  assert.equal(result.interrupted, true)
  assert.equal(result.job.cursor, 3)
  assert.equal(getJob(job.id)!.status, 'interrupted')
  // 半包不许下载。
  assert.equal(exportJobContent(getJob(job.id)!), null)
  assert.equal(downloadJob(getJob(job.id)!), false)

  // 从断掉那台接着打。
  result = pumpExport(job.id, { batchSize: 2 })
  assert.equal(result.job.cursor, 5)
  result = pumpExport(job.id, { batchSize: 2 })
  assert.equal(result.finished, true)
  assert.equal(result.job.cursor, 6)
  const file = exportJobContent(result.job)!
  const dataLines = file.content.replace(/^﻿/, '').split('\n').slice(1)
  assert.equal(dataLines.length, 6, '续导后仍是完整 6 台，无重复无缺失')
  assert.equal(new Set(dataLines).size, 6)
})

test('打包资料：对齐表台数与档案一致，带校验清单', () => {
  reseed()
  const job = runExportToCompletion('package')
  const file = exportJobContent(job)!
  assert.equal(file.filename.endsWith('.stpkg'), true)
  assert.match(file.content, /machineCount: 6/)
  assert.match(file.content, /archive\.csv/)
  assert.match(file.content, /ring-alignment\.csv/)
  assert.match(file.content, /unassignedPendingRings: 1/)
  // DG-001 在对齐表里必须是不符合退场条件。
  assert.match(file.content, /存在未闭环掘进环次，不符合退场条件/)
})
