<template>
  <section class="page" data-module="shield">
    <header class="page-head">
      <div>
        <h2>盾构机台账管理</h2>
        <p class="page-desc">列表、导出、退场打包统一读取设备档案；存量旧台账与进场补录件已按编号对账并入。</p>
      </div>
      <div class="page-actions">
        <button
          class="btn primary"
          type="button"
          :disabled="!canEdit"
          :title="canEdit ? '' : '仅设备管理员可登记盾构机'"
          @click="openCreate"
        >
          登记盾构机
        </button>
        <button class="btn" type="button" @click="quickExport">导出盾构机台账清单</button>
        <button class="btn" type="button" @click="startPackage">打包退场资料</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in statCards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item" title="列表、导出、打包三处共用同一取数口">在册台数：{{ rows.length }}</span>
    </p>

    <div v-if="unassignedCount > 0" class="warn-strip">
      另有 {{ unassignedCount }} 环待办掘进环次未挂到任何在档盾构机上（不阻挡退场，但需现场核实）
    </div>

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
          <th>未闭环环次</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] || '—' }}</td>
          <td>{{ pendingCountOf(row) }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-if="String(row.status) === '待进场'"
              class="link"
              type="button"
              @click="apply('办理进场', row)"
            >办理进场</button>
            <button
              v-if="String(row.status) === '调试中'"
              class="link"
              type="button"
              @click="apply('开始调试', row)"
            >开始调试</button>
            <button
              v-if="String(row.status) !== '已退场'"
              class="link"
              type="button"
              @click="exitMachine(row)"
            >办理退场</button>
            <button class="link" type="button" @click="openBackfill(row)">补录进场日期</button>
            <button
              class="link"
              type="button"
              :disabled="String(row.status) === '已退场'"
              :title="String(row.status) === '已退场' ? '退场设备档案已封存' : ''"
              @click="openDiameter(row)"
            >改开挖直径</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">设备档案为空</td>
        </tr>
      </tbody>
    </table>

    <!-- 补录进场日期（可与退场同一事务提交） -->
    <div v-if="backfillTarget" class="modal-mask" @click.self="closeBackfill">
      <div class="modal">
        <h3>补录进场日期 · {{ backfillTarget.盾构机编号 }}</h3>
        <p class="page-desc">日期以设备档案为准，兼容 2026/3/5、2026年3月5日 等历史写法，统一存为 yyyy-MM-dd。</p>
        <label class="filter-item">
          <span>进场日期</span>
          <input v-model="backfillDate" placeholder="yyyy-MM-dd" />
        </label>
        <p class="error-text">{{ backfillError }}</p>
        <div class="modal-actions">
          <button class="btn" type="button" @click="submitBackfillOnly">仅补录</button>
          <button
            class="btn primary"
            type="button"
            :disabled="String(backfillTarget.status) === '已退场'"
            @click="submitBackfillAndExit"
          >补录并办理退场（同一事务）</button>
          <button class="btn ghost" type="button" @click="closeBackfill">取消</button>
        </div>
      </div>
    </div>

    <!-- 修改开挖直径：已退场禁用、非设备管理员越权提交会被域层挡回 -->
    <div v-if="diameterTarget" class="modal-mask" @click.self="closeDiameter">
      <div class="modal">
        <h3>修改开挖直径 · {{ diameterTarget.盾构机编号 }}</h3>
        <p class="page-desc">
          当前角色：<strong>{{ store.role }}</strong>；仅设备管理员可改，已退场设备一律封存。
        </p>
        <label class="filter-item">
          <span>开挖直径</span>
          <input v-model="diameterValue" placeholder="如 6.28m" />
        </label>
        <p class="error-text">{{ diameterError }}</p>
        <div class="modal-actions">
          <button class="btn primary" type="button" @click="submitDiameter">提交</button>
          <button class="btn ghost" type="button" @click="closeDiameter">取消</button>
        </div>
      </div>
    </div>

    <!-- 退场资料打包：断点续导，中断后从断掉那台接着打 -->
    <div v-if="packageJob" class="modal-mask" @click.self="closePackage">
      <div class="modal">
        <h3>退场资料打包</h3>
        <p class="page-desc">档案清单 + 掘进环次待办对齐表 + 校验清单，三处台数一致才封口。</p>
        <div class="job-progress">
          进度：{{ packageJob.cursor }} / {{ packageJob.total }} 台
          <span v-if="packageJob.status === 'interrupted'" class="error-text">（已中断，可续导）</span>
          <span v-else-if="packageJob.status === 'done'">（已完成）</span>
        </div>
        <label class="filter-item">
          <input v-model="simulateBreak" type="checkbox" />
          <span>演练用：本批打完后制造一次中断</span>
        </label>
        <p class="error-text">{{ packageError }}</p>
        <div class="modal-actions">
          <button
            class="btn primary"
            type="button"
            :disabled="packageJob.status === 'done'"
            @click="pumpPackage"
          >{{ packageJob.status === 'interrupted' ? '从断点继续' : '继续打包' }}</button>
          <button
            class="btn"
            type="button"
            :disabled="packageJob.status !== 'done'"
            @click="downloadPackage"
          >下载完整资料包</button>
          <button class="btn ghost" type="button" @click="closePackage">关闭</button>
        </div>
      </div>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 台在档盾构机（与导出、打包同源）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  backfillEntryDate,
  pendingRingsFor,
  shieldStats,
  submitExitWithBackfill,
  unassignedPendingRings,
  updateDiameter,
} from '@/data/shield-domain'
import {
  createExportJob,
  downloadJob,
  getJob,
  pumpExport,
  type ExportJob,
} from '@/data/export-pipeline'
import { downloadEntries, listEntries, runAction as applyAction } from '@/api/local-service'
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const store = useSessionStore()
const canEdit = computed(() => store.canEditDiameter)

const columns = ['盾构机编号', '盾构机型号', '开挖直径', '刀盘形式', '总推力', '进场日期', '维保单位']
const filterFields = columns.slice(0, 3)
const statuses = ['待进场', '调试中', '掘进中', '已退场']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})

const stats = ref(shieldStats())
const statCards = computed(() => [
  { label: '在册盾构机', value: stats.value.total },
  { label: '在场盾构机', value: stats.value.onSite },
  { label: '掘进中盾构机', value: stats.value.boring },
  { label: '待维保盾构机', value: stats.value.pendingMaintenance },
])
const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const unassignedCount = computed(() => unassignedPendingRings().length)

function pendingCountOf(row: EntryRow): number {
  return pendingRingsFor(String(row.盾构机编号)).length
}

function resetFilters() {
  filters.value = {}
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries('shield', filters.value)
    rows.value = payload.items
    total.value = payload.total
    stats.value = shieldStats()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '盾构机档案读取失败'
  }
}

function quickExport() {
  // 与列表同选择器；打不完整内部会抛错，绝不落半包。
  downloadEntries('shield')
}

function apply(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction('shield', Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function openCreate() {
  errorMessage.value = '盾构机登记入口尚未接入审批流'
}

function exitMachine(row: EntryRow) {
  errorMessage.value = ''
  // 退场结论与掘进环次待办清单对齐：挡回时把待办环号带出来。
  const result = applyAction('shield', Number(row.id), '办理退场')
  errorMessage.value = result.ok ? '' : result.message
  reload()
}

// —— 补录 ——
const backfillTarget = ref<EntryRow | null>(null)
const backfillDate = ref('')
const backfillError = ref('')

function openBackfill(row: EntryRow) {
  backfillTarget.value = row
  backfillDate.value = String(row.进场日期 ?? '')
  backfillError.value = ''
}
function closeBackfill() {
  backfillTarget.value = null
}
function submitBackfillOnly() {
  if (!backfillTarget.value) {
    return
  }
  const result = backfillEntryDate(Number(backfillTarget.value.id), backfillDate.value)
  backfillError.value = result.ok ? '' : result.message
  if (result.ok) {
    closeBackfill()
    reload()
  }
}
function submitBackfillAndExit() {
  if (!backfillTarget.value) {
    return
  }
  // 退场与补录同一个事务：写不成就整笔退回。
  const result = submitExitWithBackfill(Number(backfillTarget.value.id), backfillDate.value)
  backfillError.value = result.ok ? '' : result.message
  if (result.ok) {
    closeBackfill()
    reload()
  }
}

// —— 开挖直径 ——
const diameterTarget = ref<EntryRow | null>(null)
const diameterValue = ref('')
const diameterError = ref('')

function openDiameter(row: EntryRow) {
  diameterTarget.value = row
  diameterValue.value = String(row.开挖直径 ?? '')
  diameterError.value = ''
}
function closeDiameter() {
  diameterTarget.value = null
}
function submitDiameter() {
  if (!diameterTarget.value) {
    return
  }
  const result = updateDiameter(
    Number(diameterTarget.value.id),
    diameterValue.value,
    { role: store.role },
  )
  diameterError.value = result.ok ? '' : result.message
  if (result.ok) {
    closeDiameter()
    reload()
  }
}

// —— 打包（断点续导） ——
const packageJobId = ref<string>('')
const packageJob = ref<ExportJob | null>(null)
const packageError = ref('')
const simulateBreak = ref(false)

function syncJob() {
  packageJob.value = packageJobId.value ? getJob(packageJobId.value) ?? null : null
}
function startPackage() {
  packageError.value = ''
  simulateBreak.value = false
  // 与列表同一筛选器：当前查到几台，包里就有几台。
  const job = createExportJob('package', filters.value)
  packageJobId.value = job.id
  syncJob()
  pumpPackage()
}
function pumpPackage() {
  packageError.value = ''
  try {
    const failAt = simulateBreak.value ? (packageJob.value?.cursor ?? 0) + 1 : undefined
    const result = pumpExport(packageJobId.value, { batchSize: 2, failAt })
    simulateBreak.value = false
    if (result.interrupted) {
      packageError.value = '导出在第 ' + result.job.cursor + ' 台处中断，已保留检查点，可从断点继续'
    }
    syncJob()
  } catch (error) {
    packageError.value = error instanceof Error ? error.message : '打包失败'
  }
}
function downloadPackage() {
  if (!packageJob.value) {
    return
  }
  const ok = downloadJob(packageJob.value)
  if (!ok) {
    packageError.value = '资料包尚未打完整，拒绝下载，避免半包流出'
  }
}
function closePackage() {
  packageJob.value = null
  packageJobId.value = ''
}

onMounted(reload)
</script>

<style scoped>
.warn-strip {
  background: #fff7ed;
  border: 1px solid #fdba74;
  color: #9a3412;
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 13px;
  margin-bottom: 10px;
}
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
}
.modal {
  background: #fff;
  border-radius: 10px;
  padding: 18px 20px;
  width: 460px;
  max-width: calc(100vw - 32px);
}
.modal h3 { margin: 0 0 8px; font-size: 15px; }
.modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
.job-progress { margin: 10px 0; font-size: 13px; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
