<script setup lang="ts">
/**
 * `/admin/dashboard` — executive KPI dashboard for the web-portal admin roles.
 *
 * Renders the tenant's headline KPIs (active field users, orders, revenue) as metric
 * cards, plus a Salesman-vs-MR segmented activity chart, from the
 * `GET /reports/dashboard-kpi` endpoint. Data is read through {@link useReporting}
 * (which layers cache-aside on top of {@link useApiClient}), so re-selecting a period
 * that was already fetched is served from cache. A period selector (today / week /
 * month) drives the aggregation window.
 *
 * Access is gated by the `auth` middleware (ADMIN_CABANG / ADMIN_PUSAT / SUPER_ADMIN);
 * the backend independently enforces the same boundary via tenant + role guards. Forced
 * Light Mode is global, so this page uses no dark-mode classes or `dark:` variants.
 */
import type { SelectItem } from '@nuxt/ui'
import {
  useReporting,
  type DashboardKpiResponse,
  type DashboardKpiQuery,
  type BranchPerformanceResponse
} from '~/composables/useReporting'
import KpiMetricCard from '~/components/dashboard/KpiMetricCard.vue'
import RoleSegmentedChart from '~/components/dashboard/RoleSegmentedChart.vue'
import BranchLeagueTable from '~/components/dashboard/BranchLeagueTable.vue'

definePageMeta({
  layout: 'default',
  middleware: 'auth'
})

useHead({ title: 'Dashboard — KF Maction Admin' })

type Period = NonNullable<DashboardKpiQuery['period']>

const reporting = useReporting()

// Selected aggregation window; defaults to the backend's own default ("month").
const period = ref<Period>('month')

const periodItems: SelectItem[] = [
  { label: 'Hari Ini', value: 'today' },
  { label: 'Minggu Ini', value: 'week' },
  { label: 'Bulan Ini', value: 'month' }
]

// SSR-friendly fetch keyed by period — refetches (from cache when fresh) on change.
const { data: kpi, pending, error, refresh } = await useAsyncData<DashboardKpiResponse>(
  'admin-dashboard-kpi',
  () => reporting.fetchDashboardKpi({ period: period.value }),
  { watch: [period] }
)

// Branch performance league table — keyed on the current calendar month/year (the
// backend's `/reports/branch-performance` window). Independent of the KPI period control.
const leagueMonth = new Date().getMonth() + 1
const leagueYear = new Date().getFullYear()

const { data: branchPerf, pending: branchPending } = await useAsyncData<BranchPerformanceResponse>(
  'admin-dashboard-branch-performance',
  () => reporting.fetchBranchPerformance({ month: leagueMonth, year: leagueYear })
)

/** Branch rows for the league table; empty until the fetch resolves. */
const branchRows = computed(() => branchPerf.value?.data ?? [])

/** Zero-valued fallback so cards/chart render structurally before data resolves. */
const EMPTY_ROLE = { total_visits: 0, effective_calls: 0, call_rate_pct: 0 }

const metrics = computed(() => kpi.value?.data ?? {
  period: period.value,
  total_active_users: 0,
  total_orders: 0,
  total_revenue: 0,
  SALESMAN: { ...EMPTY_ROLE },
  MR: { ...EMPTY_ROLE }
})

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

/** Human-readable generation timestamp for the footer caption. */
const generatedAt = computed<string | null>(() => {
  const raw = kpi.value?.meta?.generated_at
  if (!raw) return null
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString('id-ID')
})
</script>

<template>
  <div class="flex flex-col gap-6 p-4 sm:p-6">
    <!-- Header + period control -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold text-highlighted">
          Dashboard Eksekutif
        </h1>
        <p class="mt-0.5 text-sm text-muted">
          Ringkasan kinerja lapangan, tersegmentasi Salesman vs MR.
        </p>
      </div>

      <USelect
        v-model="period"
        :items="periodItems"
        value-key="value"
        icon="i-lucide-calendar"
        class="w-40"
      />
    </div>

    <!-- Error banner -->
    <UAlert
      v-if="error"
      color="error"
      variant="soft"
      icon="i-lucide-circle-alert"
      title="Gagal memuat data dashboard"
      description="Data KPI tidak dapat dimuat saat ini. Silakan coba lagi."
    >
      <template #actions>
        <UButton
          color="error"
          variant="outline"
          size="xs"
          label="Coba Lagi"
          @click="refresh()"
        />
      </template>
    </UAlert>

    <!-- Metric cards -->
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <KpiMetricCard
        label="Pengguna Aktif"
        :value="formatCount(metrics.total_active_users)"
        icon="i-lucide-users"
        accent="primary"
        caption="Salesman & MR aktif"
        :loading="pending"
      />
      <KpiMetricCard
        label="Total Order"
        :value="formatCount(metrics.total_orders)"
        icon="i-lucide-shopping-cart"
        accent="success"
        caption="Quotation dibuat (Salesman)"
        :loading="pending"
      />
      <KpiMetricCard
        label="Total Pendapatan"
        :value="formatCurrency(metrics.total_revenue)"
        icon="i-lucide-banknote"
        accent="warning"
        :loading="pending"
      />
      <KpiMetricCard
        label="Call Rate Salesman"
        :value="`${metrics.SALESMAN.call_rate_pct.toFixed(1)}%`"
        icon="i-lucide-target"
        accent="primary"
        :caption="`MR: ${metrics.MR.call_rate_pct.toFixed(1)}%`"
        :loading="pending"
      />
    </div>

    <!-- Segmented activity chart -->
    <RoleSegmentedChart
      :salesman="metrics.SALESMAN"
      :mr="metrics.MR"
      :loading="pending"
    />

    <!-- Branch performance league table (Salesman & MR ranking) -->
    <BranchLeagueTable
      :rows="branchRows"
      :loading="branchPending"
    />

    <!-- Generation footer -->
    <p
      v-if="generatedAt"
      class="text-xs text-dimmed"
    >
      Diperbarui: {{ generatedAt }}
    </p>
  </div>
</template>
