<script setup lang="ts">
/**
 * `/admin/reports` — the reporting center for the web-portal admin roles.
 *
 * A tabbed hub over the tenant's operational reports, each backed by a `/reports/*`
 * endpoint through {@link useReporting} (cache-aside on top of {@link useApiClient}):
 *  - KPI            → `GET /reports/dashboard-kpi`     (Salesman-vs-MR segmented cards + chart)
 *  - Kinerja Cabang → `GET /reports/branch-performance` (ranked branch matrix)
 *  - Call Rate      → `GET /reports/call-rate`          (per-user planned vs visited)
 *  - Transaksi      → `GET /reports/orders`             (paginated order/quotation register)
 *  - Fraud          → `GET /reports/fraud-incidents`    (paginated telemetry register)
 *
 * A shared filter bar drives the active tab: a day-level date range, a branch
 * (sales-office) id, and a Salesman/MR role filter. Not every report accepts every
 * filter — the backend keys branch-performance/call-rate on month+year and the KPI on a
 * `period`, so the filter bar toggles the relevant controls per tab and this page maps
 * the shared filter state onto each endpoint's actual query shape. Role segmentation is
 * applied server-side where supported (call-rate) and visually where the response is
 * already segmented (KPI, branch matrix).
 *
 * The page stays thin: fetching + caching live in {@link useReporting}, and each report's
 * presentation lives in a `components/report/*` table. Header export buttons stream the
 * active tab's report (Excel via {@link useReporting.downloadExport}); the PDF executive
 * summary is a separate downstream task (backend returns 501), so its button surfaces a
 * "coming soon" toast instead of triggering a broken download.
 *
 * Access is gated by the `auth` middleware (ADMIN_CABANG / ADMIN_PUSAT / SUPER_ADMIN); the
 * backend independently enforces the same boundary via tenant + role guards. Forced Light
 * Mode is global — no dark-mode classes or `dark:` variants.
 */
import { computed, ref, watch } from 'vue'
import type { TabsItem } from '@nuxt/ui'
import {
  useReporting,
  type BranchPerformanceResponse,
  type CallRateReportResponse,
  type CallRateQuery,
  type DashboardKpiResponse,
  type DashboardKpiQuery,
  type ExportOptions,
  type ExportReport,
  type FraudIncidentQuery,
  type FraudIncidentResponse,
  type OrderRegisterQuery,
  type OrderRegisterResponse
} from '~/composables/useReporting'
import ReportFilters, { type RoleFilterValue } from '~/components/report/ReportFilters.vue'
import BranchPerformanceTable from '~/components/report/BranchPerformanceTable.vue'
import CallRateTable from '~/components/report/CallRateTable.vue'
import FraudIncidentTable from '~/components/report/FraudIncidentTable.vue'
import OrderRegisterTable from '~/components/report/OrderRegisterTable.vue'
import KpiMetricCard from '~/components/dashboard/KpiMetricCard.vue'
import RoleSegmentedChart from '~/components/dashboard/RoleSegmentedChart.vue'

definePageMeta({
  layout: 'default',
  middleware: 'auth'
})

useHead({ title: 'Pusat Laporan — KF Maction Admin' })

const reporting = useReporting()
const toast = useToast()

/** Report tab identifiers (also the `UTabs` values). */
type ReportTab = 'kpi' | 'branch' | 'call-rate' | 'orders' | 'fraud'
const activeTab = ref<ReportTab>('kpi')

const tabItems: TabsItem[] = [
  { label: 'KPI', value: 'kpi', icon: 'i-lucide-gauge' },
  { label: 'Kinerja Cabang', value: 'branch', icon: 'i-lucide-building-2' },
  { label: 'Call Rate', value: 'call-rate', icon: 'i-lucide-target' },
  { label: 'Transaksi', value: 'orders', icon: 'i-lucide-receipt' },
  { label: 'Fraud', value: 'fraud', icon: 'i-lucide-shield-alert' }
]

// --- Shared filter state (mapped per-tab onto each endpoint's query shape) ---
const dateFrom = ref<string>('')
const dateTo = ref<string>('')
const month = ref<number>(new Date().getMonth() + 1)
const year = ref<number>(new Date().getFullYear())
const sofficeId = ref<string>('')
const roleFilter = ref<RoleFilterValue>('')

/** Page size for the paginated registers (matches the backend default). */
const PAGE_LIMIT = 20
const ordersPage = ref<number>(1)
const fraudPage = ref<number>(1)

// Reset register pagination whenever a filter that scopes them changes.
watch([dateFrom, dateTo, sofficeId, roleFilter], () => {
  ordersPage.value = 1
  fraudPage.value = 1
})

/** Trimmed sales-office id, or undefined when the branch filter is empty. */
const sofficeParam = computed<string | undefined>(() => {
  const trimmed = sofficeId.value.trim()
  return trimmed.length > 0 ? trimmed : undefined
})

// --- KPI tab ---
const {
  data: kpi,
  pending: kpiPending,
  error: kpiError,
  refresh: refreshKpi
} = await useAsyncData<DashboardKpiResponse>(
  'admin-reports-kpi',
  () => {
    const query: DashboardKpiQuery = { period: 'month' }
    if (sofficeParam.value) query.soffice_id = sofficeParam.value
    return reporting.fetchDashboardKpi(query)
  },
  { watch: [sofficeParam] }
)

const EMPTY_ROLE = { total_visits: 0, effective_calls: 0, call_rate_pct: 0 }
const kpiMetrics = computed(() => kpi.value?.data ?? {
  period: 'month',
  total_active_users: 0,
  total_orders: 0,
  total_revenue: 0,
  SALESMAN: { ...EMPTY_ROLE },
  MR: { ...EMPTY_ROLE }
})

// --- Branch performance tab ---
const {
  data: branch,
  pending: branchPending,
  error: branchError,
  refresh: refreshBranch
} = await useAsyncData<BranchPerformanceResponse>(
  'admin-reports-branch',
  () => reporting.fetchBranchPerformance({ month: month.value, year: year.value }),
  { watch: [month, year] }
)
const branchRows = computed(() => branch.value?.data ?? [])

// --- Call rate tab ---
const {
  data: callRate,
  pending: callRatePending,
  error: callRateError,
  refresh: refreshCallRate
} = await useAsyncData<CallRateReportResponse>(
  'admin-reports-call-rate',
  () => {
    const query: CallRateQuery = { month: month.value, year: year.value }
    if (sofficeParam.value) query.soffice_id = sofficeParam.value
    if (roleFilter.value) query.role = roleFilter.value
    return reporting.fetchCallRate(query)
  },
  { watch: [month, year, sofficeParam, roleFilter] }
)
const callRateRows = computed(() => callRate.value?.data ?? [])

// --- Order register tab ---
const {
  data: orders,
  pending: ordersPending,
  error: ordersError,
  refresh: refreshOrders
} = await useAsyncData<OrderRegisterResponse>(
  'admin-reports-orders',
  () => {
    const query: OrderRegisterQuery = { page: ordersPage.value, limit: PAGE_LIMIT }
    if (sofficeParam.value) query.soffice_id = sofficeParam.value
    if (dateFrom.value) query.date_from = dateFrom.value
    if (dateTo.value) query.date_to = dateTo.value
    return reporting.fetchOrderRegister(query)
  },
  { watch: [ordersPage, sofficeParam, dateFrom, dateTo] }
)
const orderRows = computed(() => orders.value?.data ?? [])
const orderTotal = computed(() => orders.value?.meta.total ?? 0)

// --- Fraud incidents tab ---
const {
  data: fraud,
  pending: fraudPending,
  error: fraudError,
  refresh: refreshFraud
} = await useAsyncData<FraudIncidentResponse>(
  'admin-reports-fraud',
  () => {
    const query: FraudIncidentQuery = { page: fraudPage.value, limit: PAGE_LIMIT }
    if (dateFrom.value) query.date_from = dateFrom.value
    if (dateTo.value) query.date_to = dateTo.value
    return reporting.fetchFraudIncidents(query)
  },
  { watch: [fraudPage, dateFrom, dateTo] }
)
const fraudRows = computed(() => fraud.value?.data ?? [])
const fraudTotal = computed(() => fraud.value?.meta.total ?? 0)

/** Which filter controls the active tab actually consumes (drives their visibility). */
const filterConfig = computed(() => {
  switch (activeTab.value) {
    case 'kpi':
      return { showDateRange: false, showMonthYear: false, showBranch: true, showRole: false }
    case 'branch':
      return { showDateRange: false, showMonthYear: true, showBranch: false, showRole: true }
    case 'call-rate':
      return { showDateRange: false, showMonthYear: true, showBranch: true, showRole: true }
    case 'orders':
      return { showDateRange: true, showMonthYear: false, showBranch: true, showRole: false }
    case 'fraud':
      return { showDateRange: true, showMonthYear: false, showBranch: true, showRole: false }
    default:
      return { showDateRange: true, showMonthYear: false, showBranch: true, showRole: true }
  }
})

// --- Export (Excel / PDF) ---

/** Maps the active tab to the backend export report identifier. */
const TAB_EXPORT_REPORT: Record<ReportTab, ExportReport> = {
  'kpi': 'dashboard-kpi',
  'branch': 'branch-performance',
  'call-rate': 'call-rate',
  'orders': 'orders',
  'fraud': 'fraud-incidents'
}

/** Reports the backend keys on month+year (validated via `assertMonthYear`). */
const CALENDAR_REPORTS: ReadonlySet<ExportReport> = new Set(['branch-performance', 'call-rate'])

/** Build export options from the active tab + current filter state. */
function buildExportOptions(type: ExportOptions['type']): ExportOptions {
  const report = TAB_EXPORT_REPORT[activeTab.value]
  const options: ExportOptions = { type, report }
  if (CALENDAR_REPORTS.has(report)) {
    options.month = month.value
    options.year = year.value
  }
  if (sofficeParam.value) options.soffice_id = sofficeParam.value
  return options
}

/** Stream the active tab's report as an Excel workbook. */
function exportExcel(): void {
  reporting.downloadExport(buildExportOptions('xlsx'))
}

/** PDF export is a separate downstream task (backend 501) — surface a "coming soon" note. */
function exportPdf(): void {
  toast.add({
    title: 'Ekspor PDF segera hadir',
    description: 'Ringkasan eksekutif PDF sedang disiapkan. Gunakan ekspor Excel untuk saat ini.',
    color: 'info',
    icon: 'i-lucide-file-text'
  })
}

/** Format an integer with Indonesian locale grouping. */
function formatCount(value: number): string {
  return value.toLocaleString('id-ID')
}

/** Format a rupiah amount as a compact currency string (no fractional cents). */
function formatCurrency(value: number): string {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0
  }).format(value)
}
</script>

<template>
  <div class="flex flex-col gap-6 p-4 sm:p-6">
    <!-- Header -->
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold text-highlighted">
          Pusat Laporan
        </h1>
        <p class="mt-0.5 text-sm text-muted">
          Laporan operasional tenant — tersegmentasi Salesman vs MR.
        </p>
      </div>

      <!-- Export actions (reflect the active tab + current filters) -->
      <div class="flex items-center gap-2">
        <UButton
          color="success"
          variant="soft"
          icon="i-lucide-file-spreadsheet"
          label="Ekspor Excel"
          @click="exportExcel()"
        />
        <UButton
          color="primary"
          variant="soft"
          icon="i-lucide-file-text"
          label="Ekspor PDF"
          @click="exportPdf()"
        />
      </div>
    </div>

    <!-- Tab navigation -->
    <UTabs
      v-model="activeTab"
      :items="tabItems"
      color="primary"
      :content="false"
    />

    <!-- Shared filter bar (controls toggle per active tab) -->
    <ReportFilters
      v-model:date-from="dateFrom"
      v-model:date-to="dateTo"
      v-model:month="month"
      v-model:year="year"
      v-model:soffice-id="sofficeId"
      v-model:role="roleFilter"
      :show-date-range="filterConfig.showDateRange"
      :show-month-year="filterConfig.showMonthYear"
      :show-branch="filterConfig.showBranch"
      :show-role="filterConfig.showRole"
    />

    <!-- KPI tab -->
    <div
      v-if="activeTab === 'kpi'"
      class="flex flex-col gap-6"
    >
      <UAlert
        v-if="kpiError"
        color="error"
        variant="soft"
        icon="i-lucide-circle-alert"
        title="Gagal memuat KPI"
        description="Data KPI tidak dapat dimuat saat ini. Silakan coba lagi."
      >
        <template #actions>
          <UButton
            color="error"
            variant="outline"
            size="xs"
            label="Coba Lagi"
            @click="refreshKpi()"
          />
        </template>
      </UAlert>

      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiMetricCard
          label="Pengguna Aktif"
          :value="formatCount(kpiMetrics.total_active_users)"
          icon="i-lucide-users"
          accent="primary"
          caption="Salesman & MR aktif"
          :loading="kpiPending"
        />
        <KpiMetricCard
          label="Total Order"
          :value="formatCount(kpiMetrics.total_orders)"
          icon="i-lucide-shopping-cart"
          accent="success"
          caption="Quotation dibuat (Salesman)"
          :loading="kpiPending"
        />
        <KpiMetricCard
          label="Total Pendapatan"
          :value="formatCurrency(kpiMetrics.total_revenue)"
          icon="i-lucide-banknote"
          accent="warning"
          :loading="kpiPending"
        />
        <KpiMetricCard
          label="Call Rate Salesman"
          :value="`${kpiMetrics.SALESMAN.call_rate_pct.toFixed(1)}%`"
          icon="i-lucide-target"
          accent="primary"
          :caption="`MR: ${kpiMetrics.MR.call_rate_pct.toFixed(1)}%`"
          :loading="kpiPending"
        />
      </div>

      <RoleSegmentedChart
        :salesman="kpiMetrics.SALESMAN"
        :mr="kpiMetrics.MR"
        :loading="kpiPending"
      />
    </div>

    <!-- Branch performance tab -->
    <div
      v-else-if="activeTab === 'branch'"
      class="flex flex-col gap-4"
    >
      <UAlert
        v-if="branchError"
        color="error"
        variant="soft"
        icon="i-lucide-circle-alert"
        title="Gagal memuat kinerja cabang"
        description="Data kinerja cabang tidak dapat dimuat saat ini. Silakan coba lagi."
      >
        <template #actions>
          <UButton
            color="error"
            variant="outline"
            size="xs"
            label="Coba Lagi"
            @click="refreshBranch()"
          />
        </template>
      </UAlert>

      <BranchPerformanceTable
        :rows="branchRows"
        :loading="branchPending"
        :role-filter="roleFilter"
      />
    </div>

    <!-- Call rate tab -->
    <div
      v-else-if="activeTab === 'call-rate'"
      class="flex flex-col gap-4"
    >
      <UAlert
        v-if="callRateError"
        color="error"
        variant="soft"
        icon="i-lucide-circle-alert"
        title="Gagal memuat call rate"
        description="Data call rate tidak dapat dimuat saat ini. Silakan coba lagi."
      >
        <template #actions>
          <UButton
            color="error"
            variant="outline"
            size="xs"
            label="Coba Lagi"
            @click="refreshCallRate()"
          />
        </template>
      </UAlert>

      <CallRateTable
        :rows="callRateRows"
        :loading="callRatePending"
      />
    </div>

    <!-- Order register tab -->
    <div
      v-else-if="activeTab === 'orders'"
      class="flex flex-col gap-4"
    >
      <UAlert
        v-if="ordersError"
        color="error"
        variant="soft"
        icon="i-lucide-circle-alert"
        title="Gagal memuat transaksi"
        description="Daftar transaksi tidak dapat dimuat saat ini. Silakan coba lagi."
      >
        <template #actions>
          <UButton
            color="error"
            variant="outline"
            size="xs"
            label="Coba Lagi"
            @click="refreshOrders()"
          />
        </template>
      </UAlert>

      <OrderRegisterTable
        :rows="orderRows"
        :loading="ordersPending"
      />

      <div class="flex flex-wrap items-center justify-between gap-3">
        <p class="text-xs text-dimmed">
          Menampilkan {{ orderRows.length }} dari {{ orderTotal }} transaksi.
        </p>
        <UPagination
          v-if="orderTotal > PAGE_LIMIT"
          v-model:page="ordersPage"
          :items-per-page="PAGE_LIMIT"
          :total="orderTotal"
        />
      </div>
    </div>

    <!-- Fraud incidents tab -->
    <div
      v-else-if="activeTab === 'fraud'"
      class="flex flex-col gap-4"
    >
      <UAlert
        v-if="fraudError"
        color="error"
        variant="soft"
        icon="i-lucide-circle-alert"
        title="Gagal memuat insiden fraud"
        description="Data telemetri fraud tidak dapat dimuat saat ini. Silakan coba lagi."
      >
        <template #actions>
          <UButton
            color="error"
            variant="outline"
            size="xs"
            label="Coba Lagi"
            @click="refreshFraud()"
          />
        </template>
      </UAlert>

      <FraudIncidentTable
        :rows="fraudRows"
        :loading="fraudPending"
      />

      <div class="flex flex-wrap items-center justify-between gap-3">
        <p class="text-xs text-dimmed">
          Menampilkan {{ fraudRows.length }} dari {{ fraudTotal }} insiden.
        </p>
        <UPagination
          v-if="fraudTotal > PAGE_LIMIT"
          v-model:page="fraudPage"
          :items-per-page="PAGE_LIMIT"
          :total="fraudTotal"
        />
      </div>
    </div>
  </div>
</template>
