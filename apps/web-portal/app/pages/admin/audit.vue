<script setup lang="ts">
/**
 * `/admin/audit` — the fraud & audit telemetry viewer for the web-portal admin roles.
 *
 * A single-purpose register over the anti-spoofing pipeline's soft rejections (logged to
 * `audit_fraud_telemetry`), read through {@link useReporting.fetchFraudIncidents}
 * (`GET /reports/fraud-incidents`, paginated + cache-aside on top of {@link useApiClient}).
 * Only fraud incidents are exposed via the reporting routes — there is no separate
 * mutation-log endpoint — so this page scopes itself to the fraud telemetry register that
 * Admin Cabang triages.
 *
 * The page stays thin: fetching + caching live in {@link useReporting}, and the register's
 * presentation lives in {@link FraudIncidentTable}. A filter bar (fraud type, day-level date
 * range, optional user id) scopes the fetch; changing any filter resets pagination. A single
 * summary card surfaces the total incident count for the active filter from `meta.total`.
 *
 * Access is gated by the `auth` middleware (ADMIN_CABANG / ADMIN_PUSAT / SUPER_ADMIN); the
 * backend independently enforces the same boundary via tenant + role guards. Forced Light
 * Mode is global — no dark-mode classes or `dark:` variants.
 */
import { computed, ref, watch } from 'vue'
import type { SelectItem } from '@nuxt/ui'
import {
  useReporting,
  type FraudIncidentQuery,
  type FraudIncidentResponse,
  type FraudType
} from '~/composables/useReporting'
import FraudIncidentTable from '~/components/report/FraudIncidentTable.vue'

definePageMeta({
  layout: 'default',
  middleware: 'auth'
})

useHead({ title: 'Audit & Fraud Telemetry — KF Maction Admin' })

const reporting = useReporting()

/** Page size for the paginated register (matches the backend default). */
const PAGE_LIMIT = 20

// --- Filter state ---
/** Empty string means "all fraud types"; otherwise a bounded {@link FraudType}. */
const fraudType = ref<'' | FraudType>('')
const dateFrom = ref<string>('')
const dateTo = ref<string>('')
const userId = ref<string>('')
const page = ref<number>(1)

/** Fraud type options — labels mirror FraudIncidentTable's FRAUD_LABELS. */
const fraudTypeItems: SelectItem[] = [
  { label: 'Semua Jenis', value: '' },
  { label: 'Lokasi Palsu', value: 'MOCK_LOCATION' },
  { label: 'Anomali Kecepatan', value: 'VELOCITY_ANOMALY' },
  { label: 'Akurasi Berlebih', value: 'ACCURACY_EXCESS' },
  { label: 'Drift Waktu', value: 'CLOCK_DRIFT' }
]

// Reset pagination whenever a filter that scopes the register changes.
watch([fraudType, dateFrom, dateTo, userId], () => {
  page.value = 1
})

/** Trimmed user id, or undefined when the filter is empty. */
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
  'admin-audit-fraud',
  () => {
    const query: FraudIncidentQuery = { page: page.value, limit: PAGE_LIMIT }
    if (fraudType.value) query.fraud_type = fraudType.value
    if (dateFrom.value) query.date_from = dateFrom.value
    if (dateTo.value) query.date_to = dateTo.value
    if (userIdParam.value) query.user_id = userIdParam.value
    return reporting.fetchFraudIncidents(query)
  },
  { watch: [page, fraudType, dateFrom, dateTo, userIdParam] }
)

const fraudRows = computed(() => fraud.value?.data ?? [])
const fraudTotal = computed(() => fraud.value?.meta.total ?? 0)

/** Whether any filter currently deviates from its default (drives the clear button). */
const hasActiveFilters = computed<boolean>(() =>
  Boolean(fraudType.value || dateFrom.value || dateTo.value || userIdParam.value)
)

/** Reset the filters back to their defaults. */
function clearFilters(): void {
  fraudType.value = ''
  dateFrom.value = ''
  dateTo.value = ''
  userId.value = ''
}

/** Format an integer with Indonesian locale grouping. */
function formatCount(value: number): string {
  return value.toLocaleString('id-ID')
}
</script>

<template>
  <div class="flex flex-col gap-6 p-4 sm:p-6">
    <!-- Header -->
    <div>
      <h1 class="text-xl font-semibold text-highlighted">
        Audit & Fraud Telemetry
      </h1>
      <p class="mt-0.5 max-w-3xl text-sm text-muted">
        Register insiden dari pipeline anti-spoofing — penolakan lunak (soft rejection) yang
        tercatat pada telemetri fraud dan ditinjau oleh Admin Cabang.
      </p>
    </div>

    <!-- Summary KPI -->
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <div class="flex items-center gap-3 rounded-lg border border-default bg-elevated p-4">
        <div class="flex size-10 items-center justify-center rounded-lg bg-error/10 text-error">
          <UIcon
            name="i-lucide-shield-alert"
            class="size-5"
          />
        </div>
        <div>
          <p class="text-xs text-muted">
            Total Insiden (filter aktif)
          </p>
          <p class="text-lg font-semibold text-highlighted tabular-nums">
            {{ formatCount(fraudTotal) }}
          </p>
        </div>
      </div>
    </div>

    <!-- Filter bar -->
    <div class="flex flex-col gap-3">
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <USelect
          v-model="fraudType"
          :items="fraudTypeItems"
          value-key="value"
          icon="i-lucide-shield-alert"
          aria-label="Jenis fraud"
          class="w-full"
        />
        <UInput
          v-model="dateFrom"
          type="date"
          icon="i-lucide-calendar"
          aria-label="Tanggal mulai"
          class="w-full"
        />
        <UInput
          v-model="dateTo"
          type="date"
          icon="i-lucide-calendar-days"
          aria-label="Tanggal akhir"
          class="w-full"
        />
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

    <!-- Fraud register -->
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
