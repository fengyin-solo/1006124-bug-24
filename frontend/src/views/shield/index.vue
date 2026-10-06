<template>
  <section class="page" data-module="shield">
    <header class="page-head">
      <div>
        <h2>盾构机台账管理</h2>
        <p class="page-desc">列表、导出、打包都读设备档案同一份数据；进场日期以设备档案统一算法为准，维保单位只留全称一种写法。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openBackfill">补录进场日期</button>
        <button class="btn" type="button" @click="exportRows">导出盾构机台账清单</button>
        <button class="btn" type="button" @click="packArchive">打包设备档案</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item" v-if="maintainerNote">{{ maintainerNote }}</span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            <template v-if="column === '开挖直径'">
              <button class="link" type="button" @click="editDiameter(row)" title="点击修改；退场后锁定">
                {{ row[column] ?? '—' }}
              </button>
            </template>
            <template v-else>{{ row[column] ?? '—' }}</template>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">设备档案暂无盾构机记录，可先补录进场日期</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>设备档案共 {{ total }} 台（列表、导出、打包、运营概览同源同口径）</span>
      <span v-if="resumeHint" class="resume-text">{{ resumeHint }}</span>
      <span v-if="okMessage" class="ok-text">{{ okMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  backfillShieldEntry,
  downloadPack,
  downloadShieldEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
  shieldExportProgress,
  shieldMetrics,
  updateShieldField,
} from '@/api/local-service'
import { distinctMaintainers } from '@/data/shield-archive'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('shield')
const columns = ['盾构机编号', '盾构机型号', '开挖直径', '刀盘形式', '总推力', '进场日期', '维保单位', '设备状态', '退场结论']
const actions = ['办理进场', '开始调试', '办理退场']
const statuses = ['待进场', '调试中', '掘进中', '已退场']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const okMessage = ref('')
const resumeHint = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const stats = ref(shieldMetrics())
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const maintainerNote = computed(() => {
  const names = distinctMaintainers(rows.value)
  if (!names.length) {
    return ''
  }
  return names.length === 1
    ? `维保单位写法已统一：${names[0]}`
    : `维保单位仍有 ${names.length} 种写法，重新打开页面后会按档案归并`
})

function flashOk(message: string) {
  okMessage.value = message
  errorMessage.value = ''
}

function flashError(message: string) {
  errorMessage.value = message
  okMessage.value = ''
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  try {
    const result = downloadShieldEntries()
    flashOk(result.message)
  } catch (error) {
    flashError(error instanceof Error ? error.message : '导出中断，断点已保留，可从断掉的那台继续')
  }
}

function packArchive() {
  try {
    flashOk(downloadPack(meta.key))
  } catch (error) {
    flashError(error instanceof Error ? error.message : '设备档案打包失败')
  }
}

function openBackfill() {
  const code = window.prompt('补录进场日期：请输入盾构机编号（同一条重复提交只记一次）')
  if (code === null) {
    return
  }
  const date = window.prompt('请输入进场日期（YYYY-MM-DD，兼容 2026/8/12、2026年8月12日 等历史写法）')
  if (date === null) {
    return
  }
  const result = backfillShieldEntry({ 盾构机编号: code, 进场日期: date })
  if (!result.ok) {
    flashError(result.message)
    return
  }
  flashOk(result.message)
  reload()
}

function editDiameter(row: EntryRow) {
  if (String(row.status) === '已退场') {
    // 越权提交会被服务层挡回，这里先直接提示。
    flashError(`${row['盾构机编号']} 已退场，开挖直径锁定，不允许再修改`)
    return
  }
  const value = window.prompt(`修改 ${row['盾构机编号']} 的开挖直径（退场后将锁定）`, String(row['开挖直径'] ?? ''))
  if (value === null) {
    return
  }
  const result = updateShieldField(Number(row.id), '开挖直径', value)
  if (!result.ok) {
    flashError(result.message)
    return
  }
  flashOk(result.message)
  reload()
}

function runAction(action: string, row: EntryRow) {
  let 进场日期: string | undefined
  if (action === '办理退场' || action === '办理进场') {
    const answer = window.prompt(
      `${action}时可一并补录进场日期（留空则不改，格式 YYYY-MM-DD）`,
      String(row['进场日期'] ?? ''),
    )
    if (answer === null) {
      return
    }
    进场日期 = answer.trim() || undefined
  }
  let result = applyAction(meta.key, Number(row.id), action, 进场日期 ? { 进场日期 } : {})
  // 无主待办挡回时，让用户确认后再提交一次（结论里会注明人工已核对）。
  if (!result.ok && /未挂盾构机编号|无法确认归属/.test(result.message)) {
    const confirmAgain = window.confirm(`${result.message}\n\n确认这些待办与本机无关，仍要办理退场吗？`)
    if (confirmAgain) {
      result = applyAction(meta.key, Number(row.id), action, { 进场日期, 确认无主待办: true })
    }
  }
  if (!result.ok) {
    flashError(result.message)
    return
  }
  flashOk(result.message)
  reload()
}

function reload() {
  errorMessage.value = ''
  okMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    stats.value = shieldMetrics()
    const progress = shieldExportProgress()
    resumeHint.value = progress && progress.done < progress.total
      ? `上次导出在第 ${progress.done}/${progress.total} 台中断，再次导出会从断掉的那台接着打`
      : ''
  } catch (error) {
    flashError(error instanceof Error ? error.message : '盾构机台账列表读取失败')
  }
}

onMounted(reload)
</script>
