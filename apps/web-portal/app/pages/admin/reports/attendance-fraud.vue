<script setup lang="ts">
/**
 * `/admin/reports/attendance-fraud` — the attendance & fraud incident report.
 *
 * A report-style view over the anti-spoofing telemetry that field attendance (and visit)
 * check-ins produce. Every incident row here is a soft rejection recorded by the
 * anti-spoofing pipeline during a Salesman/MR GPS attendance or visit event — mock
 * locations, velocity anomalies, excess accuracy, and clock drift — read through
 * {@link useReporting.fetchFraudIncidents} (`GET /reports/fraud-incidents`, paginated +
 * cache-aside on top of {@link useApiClient}).
 *
 * It differs from the raw `/admin/audit` viewer by presenting the register as a report:
 * per-type summary cards (one per fraud telemetry type), a shared report filter bar
 * (day-level date range + optional field-user id), and an Excel export button consistent
 * with the reporting center. The backend `/reports/*` surface exposes no cross-user
 * attendance-history endpoint (that route is field-force scoped to the caller), so the
 * attendance dimension surfaced to admins is exactly this integrity telemetry.
 *
 * The page stays thin: fetching + caching live in {@link useReporting}, the register's
 * presentation lives in {@link FraudIncidentTable}, and the filter controls live in
 * {@link ReportFilters}. Changing any filter resets pagination.
 *
 * Access is gated by the `auth` middleware (ADMIN_CABANG / ADMIN_PUSAT / SUPER_ADMIN); the
 * backend independently enforces the same boundary via tenant + role guards. Forced Light
 * Mode is global — no dark-mode classes or `dark:` variants.
 */
import { computed, ref, watch } from 'vue'
import {
  useReporting,
  type ExportOptions,
  type FraudIncidentQuery,
  type FraudIncidentResponse,
  type FraudType
} from '~/composables/useReporting'
import ReportFilters, { type RoleFilterValue } from '~/components/report/ReportFilters.vue'
import FraudIncidentTable from '~/components/report/FraudIncidentTable.vue'

definePageMeta({
  layout: 'default',
  middleware: 'auth'
})

useHead({ title: 'Laporan Absensi & Insiden Fraud — KF Maction Admin' })

const reporting = useReporting()

/** Page size for the paginated register (matches the backend default). */
const PAGE_LIMIT = 20

// --- Filter state (shared report filter bar drives the fetch) ---
const dateFrom = ref<string>('')
const dateTo = ref<string>('')
const sofficeId = ref<string>('')
const roleFilter = ref<RoleFilterValue>('')
const userId = ref<string>('')
const page = ref<number>(1)

// Reset pagination whenever a filter that scopes the register changes.
watch([dateFrom, dateTo, sofficeId, roleFilter, userId], () => {
  page.value = 1
})

/** Trimmed field-user id, or undefined when the filter is empty. */
const userIdParam = computed<string | undefined>(() => {
  const trimmed = userId.value.trim()
  return trimmed.length > 0 ? trimmed : undefined
})

const {
  data: fraud,
  pending: fraudPending,
  error: fraudError,
  refresh
} = await useAsyncData<FraudIncidentResponse>(
  'admin-reports-attendance-fraud',
  () => {
    const query: FraudIncidentQuery = { page: page.value, limit: PAGE_LIMIT }
    if (dateFrom.value) query.date_from = dateFrom.value
    if (dateTo.value) query.date_to = dateTo.value
    if (userIdParam.value) query.user_id = userIdParam.value
    return reporting.fetchFraudIncidents(query)
  },
  { watch: [page, dateFrom, dateTo, userIdParam] }
)

const fraudRows = computed(() => fraud.value?.data ?? [])
const fraudTotal = computed(() => fraud.value?.meta.total ?? 0)

/** The four telemetry types surfaced as summary cards (matches the anti-spoofing pipeline). */
interface FraudTypeSummary {
  type: FraudType
  label: string
  icon: string
  count: number
}

/** Per-type incident counts for the visible page, keyed by fraud type. */
const typeSummaries = computed<FraudTypeSummary[]>(() => {
  const base: FraudTypeSummary[] = [
    { type: 'MOCK_LOCATION', label: 'Lokasi Palsu', icon: 'i-lucide-map-pin-off', count: 0 },
    { type: 'VELOCITY_ANOMALY', label: 'Anomali Kecepatan', icon: 'i-lucide-gauge', count: 0 },
    { type: 'ACCURACY_EXCESS', label: 'Akurasi Berlebih', icon: 'i-lucide-crosshair', count: 0 },
    { type: 'CLOCK_DRIFT', label: 'Drift Waktu', icon: 'i-lucide-clock-alert', count: 0 }
  ]
  const counts = new Map<FraudType, number>()
  for (const row of fraudRows.value) {
    counts.set(row.fraud_type, (counts.get(row.fraud_type) ?? 0) + 1)
  }
  return base.map(summary => ({ ...summary, count: counts.get(summary.type) ?? 0 }))
})

/** Whether any filter currently deviates from its default (drives the clear button). */
const hasActiveFilters = computed<boolean>(() =>
  Boolean(dateFrom.value || dateTo.value || sofficeId.value.trim() || roleFilter.value || userIdParam.value)
)

/** Reset the filters back to their defaults. */
function clearFilters(): void {
  dateFrom.value = ''
  dateTo.value = ''
  sofficeId.value = ''
  roleFilter.value = ''
  userId.value = ''
}

/** Build export options from the current filter state. */
function buildExportOptions(type: ExportOptions['type']): ExportOptions {
  const options: ExportOptions = { type, report: 'fraud-incidents' }
  const trimmedSoffice = sofficeId.value.trim()
  if (trimmedSoffice.length > 0) options.soffice_id = trimmedSoffice
  return options
}

/** Stream the fraud incident report as an Excel workbook. */
function exportExcel(): void {
  reporting.downloadExport(buildExportOptions('xlsx'))
}

/** Format an integer with Indonesian locale grouping. */
function formatCount(value: number): string {
  return value.toLocaleString('id-ID')
}
</script>

<template>
  <div class="flex flex-col gap-6 p-4 sm:p-6">
    <!-- Header -->
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold text-highlighted">
          Laporan Absensi & Insiden Fraud
        </h1>
        <p class="mt-0.5 max-w-3xl text-sm text-muted">
          Register integritas absensi & kunjungan lapangan — insiden anti-spoofing
          (penolakan lunak) dari check-in Salesman & MR, tersegmentasi menurut jenis fraud.
        </p>
      </div>

      <UButton
        color="success"
        variant="soft"
        icon="i-lucide-file-spreadsheet"
        label="Ekspor Excel"
        @click="exportExcel()"
      />
    </div>

    <!-- Per-type summary cards -->
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <div
        v-for="summary in typeSummaries"
        :key="summary.type"
        class="flex items-center gap-3 rounded-lg border border-default bg-elevated p-4"
      >
        <div class="flex size-10 items-center justify-center rounded-lg bg-error/10 text-error">
          <UIcon
            :name="summary.icon"
            class="size-5"
          />
        </div>
        <div>
          <p class="text-xs text-muted">
            {{ summary.label }}
          </p>
          <p class="text-lg font-semibold text-highlighted tabular-nums">
            {{ formatCount(summary.count) }}
          </p>
        </div>
      </div>
    </div>

    <!-- Shared filter bar (date range + branch + role) -->
    <ReportFilters
      v-model:date-from="dateFrom"
      v-model:date-to="dateTo"
      v-model:soffice-id="sofficeId"
      v-model:role="roleFilter"
      :show-date-range="true"
      :show-month-year="false"
      :show-branch="true"
      :show-role="true"
    />

    <!-- Field-user filter (fraud-incidents endpoint keys on user_id) -->
    <div class="flex flex-col gap-3">
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <UInput
          v-model="userId"
          icon="i-lucide-user"
          placeholder="ID Pengguna (opsional)"
          aria-label="ID pengguna"
          class="w-full"
        />
      </div>

      <div v-if="hasActiveFilters">
        <UButton
          icon="i-lucide-x"
          color="neutral"
          variant="ghost"
          size="xs"
          label="Bersihkan filter"
          @click="clearFilters"
        />
      </div>
    </div>

    <!-- Error state -->
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
          @click="refresh()"
        />
      </template>
    </UAlert>

    <!-- Fraud incident register -->
    <div class="flex flex-col gap-4">
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
          v-model:page="page"
          :items-per-page="PAGE_LIMIT"
          :total="fraudTotal"
        />
      </div>
    </div>
  </div>
</template>
