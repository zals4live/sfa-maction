<script setup lang="ts">
/**
 * `/admin/call-plans` — Sales Call Plan (SCP/MVP) management for the web-portal admin roles.
 *
 * Three concerns share one screen behind a tab switcher, all driven by a single tenant-scoped
 * {@link useCallPlans} instance:
 *  - "Rencana": a paginated, filterable list over the call-plan register (`GET /call-plans`),
 *    surfacing each plan's approval status (`is_approved`) as a badge plus an approval filter.
 *  - "Unggah": a bulk-upload form for Salesman & MR plans (`POST /call-plans/bulk-upload`),
 *    accepting CSV-pasted or manually entered rows and reporting the created count and any
 *    per-row errors returned by the backend.
 *  - "Analitik": call-rate analytics (`GET /call-plans/analytics`) with a month/year picker and
 *    role filter, rendering per-user rows plus a Salesman-vs-MR summary via {@link RoleComparisonBar}.
 *
 * The list and analytics are server-driven fetches keyed on their filter refs (same pattern as
 * `/admin/lini`). Access is gated by the `auth` middleware (ADMIN roles on the backend); the
 * bulk-upload and analytics endpoints additionally enforce admin-only server-side. Forced Light
 * Mode is global — no `dark:` variants, semantic tokens only.
 */
import { computed, ref, watch } from 'vue'
import type { TabsItem } from '@nuxt/ui'
import {
  useCallPlans,
  type BulkPlanItem,
  type BulkUploadError,
  type CallPlanAnalyticsResponse,
  type CallPlanListResponse,
  type CallPlanResponse,
  type CallPlanRole,
  type ListCallPlansQuery
} from '~/composables/useCallPlans'
import RoleComparisonBar from '~/components/dashboard/RoleComparisonBar.vue'

definePageMeta({
  layout: 'default',
  middleware: 'auth'
})

useHead({ title: 'Rencana Kunjungan — KF Maction Admin' })

const api = useCallPlans()
const toast = useToast()

/** Page size for the paginated plan list (matches the backend default). */
const PAGE_LIMIT = 20

// --- Tabs ---
const activeTab = ref<string>('plans')
const tabItems: TabsItem[] = [
  { label: 'Rencana', value: 'plans', icon: 'i-lucide-calendar-check' },
  { label: 'Unggah', value: 'upload', icon: 'i-lucide-upload' },
  { label: 'Analitik', value: 'analytics', icon: 'i-lucide-chart-bar' }
]

// --- Shared month/year option builders ---
const MONTH_LABELS = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'
]
const now = new Date()
const monthItems = MONTH_LABELS.map((label, i) => ({ label, value: i + 1 }))
const yearItems = Array.from({ length: 6 }, (_, i) => {
  const year = now.getFullYear() - i
  return { label: String(year), value: year }
})

// =====================================================================================
// Rencana (list) tab state
// =====================================================================================
const listPage = ref<number>(1)
const listUserId = ref<string>('')
const listMonth = ref<number | ''>('')
const listYear = ref<number | ''>('')
const listApproval = ref<'' | 'true' | 'false'>('')

const approvalItems = [
  { label: 'Semua Status', value: '' },
  { label: 'Disetujui', value: 'true' },
  { label: 'Menunggu', value: 'false' }
]
const listMonthItems = [{ label: 'Semua Bulan', value: '' }, ...monthItems]
const listYearItems = [{ label: 'Semua Tahun', value: '' }, ...yearItems]

/** Build the list query from the filter refs, dropping empty selections. */
function buildListQuery(): ListCallPlansQuery {
  const query: ListCallPlansQuery = { page: listPage.value, limit: PAGE_LIMIT }
  if (listUserId.value.trim()) query.user_id = listUserId.value.trim()
  if (listMonth.value !== '') query.month = listMonth.value
  if (listYear.value !== '') query.year = listYear.value
  if (listApproval.value) query.is_approved = listApproval.value === 'true'
  return query
}

// Reset to the first page whenever a filter (other than the page itself) changes.
watch([listUserId, listMonth, listYear, listApproval], () => {
  listPage.value = 1
})

const {
  data: listData,
  pending: listPending,
  error: listError,
  refresh: refreshList
} = await useAsyncData<CallPlanListResponse>(
  'admin-call-plans',
  () => api.listCallPlans(buildListQuery()),
  { watch: [listPage, listUserId, listMonth, listYear, listApproval] }
)

const planRows = computed<CallPlanResponse[]>(() => listData.value?.data ?? [])
const planTotal = computed<number>(() => listData.value?.meta.total ?? 0)

/** Format an ISO/date string as a compact Indonesian date. */
function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' })
}

// =====================================================================================
// Unggah (bulk upload) tab state
// =====================================================================================
/** A single editable upload row (strings so the form binds cleanly; validated on submit). */
interface UploadRow {
  user_id: string
  customer_id: string
  outlet_context_id: string
  plan_date: string
}

function emptyRow(): UploadRow {
  return { user_id: '', customer_id: '', outlet_context_id: '', plan_date: '' }
}

const uploadRows = ref<UploadRow[]>([emptyRow()])
const csvInput = ref<string>('')
const uploading = ref<boolean>(false)
const uploadResult = ref<{ created: number, errors: BulkUploadError[] } | null>(null)

function addRow(): void {
  uploadRows.value.push(emptyRow())
}

function removeRow(index: number): void {
  uploadRows.value.splice(index, 1)
  if (uploadRows.value.length === 0) uploadRows.value.push(emptyRow())
}

/**
 * Parse pasted CSV into upload rows. Expected columns (comma-separated), header optional:
 * `user_id, customer_id, plan_date, outlet_context_id?`.
 */
function parseCsv(): void {
  const lines = csvInput.value.split('\n').map(l => l.trim()).filter(Boolean)
  const rows: UploadRow[] = []
  for (const line of lines) {
    const cols = line.split(',').map(c => c.trim())
    if (cols[0]?.toLowerCase() === 'user_id') continue // skip header
    rows.push({
      user_id: cols[0] ?? '',
      customer_id: cols[1] ?? '',
      plan_date: cols[2] ?? '',
      outlet_context_id: cols[3] ?? ''
    })
  }
  if (rows.length === 0) {
    toast.add({ title: 'Tidak ada baris CSV yang dapat diproses', color: 'warning' })
    return
  }
  uploadRows.value = rows
  toast.add({ title: `${rows.length} baris dimuat dari CSV`, color: 'success' })
}

/** Map the editable rows into the backend `plans` payload, dropping fully empty rows. */
function toPlans(): BulkPlanItem[] {
  return uploadRows.value
    .filter(r => r.user_id.trim() || r.customer_id.trim() || r.plan_date.trim())
    .map((r) => {
      const plan: BulkPlanItem = {
        user_id: r.user_id.trim(),
        customer_id: r.customer_id.trim(),
        plan_date: r.plan_date.trim()
      }
      if (r.outlet_context_id.trim()) plan.outlet_context_id = r.outlet_context_id.trim()
      return plan
    })
}

const canSubmitUpload = computed<boolean>(() => {
  const plans = toPlans()
  return plans.length > 0 && plans.every(p => p.user_id && p.customer_id && p.plan_date)
})

async function submitUpload(): Promise<void> {
  const plans = toPlans()
  if (plans.length === 0) return
  uploading.value = true
  uploadResult.value = null
  try {
    const result = await api.bulkUploadCallPlans({ plans })
    uploadResult.value = result.data
    toast.add({ title: `${result.data.created} rencana dibuat`, color: 'success' })
    if (result.data.errors.length === 0) {
      uploadRows.value = [emptyRow()]
      csvInput.value = ''
      await refreshList()
    }
  } catch {
    toast.add({ title: 'Gagal mengunggah rencana kunjungan', color: 'error' })
  } finally {
    uploading.value = false
  }
}

// =====================================================================================
// Analitik (analytics) tab state
// =====================================================================================
const analyticsMonth = ref<number>(now.getMonth() + 1)
const analyticsYear = ref<number>(now.getFullYear())
const analyticsRole = ref<'' | CallPlanRole>('')

const roleItems = [
  { label: 'Semua Peran', value: '' },
  { label: 'Salesman', value: 'SALESMAN' },
  { label: 'MR', value: 'MR' }
]

const {
  data: analyticsData,
  pending: analyticsPending,
  error: analyticsError,
  refresh: refreshAnalytics
} = await useAsyncData<CallPlanAnalyticsResponse>(
  'admin-call-plan-analytics',
  () => api.getCallPlanAnalytics({
    month: analyticsMonth.value,
    year: analyticsYear.value,
    ...(analyticsRole.value ? { role_filter: analyticsRole.value } : {})
  }),
  { watch: [analyticsMonth, analyticsYear, analyticsRole], immediate: false }
)

// Fetch analytics lazily the first time its tab is opened, and keep it live afterwards.
const analyticsLoaded = ref<boolean>(false)
watch(activeTab, (tab) => {
  if (tab === 'analytics' && !analyticsLoaded.value) {
    analyticsLoaded.value = true
    void refreshAnalytics()
  }
})

const analyticsRows = computed<CallPlanAnalyticsResponse['data']>(() => analyticsData.value?.data ?? [])
const salesmanSummary = computed(() => analyticsData.value?.summary.SALESMAN ?? null)
const mrSummary = computed(() => analyticsData.value?.summary.MR ?? null)
</script>

<template>
  <div class="flex flex-col gap-6 p-4 sm:p-6">
    <!-- Header -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold text-highlighted">
          Rencana Kunjungan
        </h1>
        <p class="mt-0.5 text-sm text-muted">
          Kelola rencana kunjungan Salesman &amp; MR, unggah massal, dan pantau call rate.
        </p>
      </div>
    </div>

    <UTabs
      v-model="activeTab"
      :items="tabItems"
      :content="false"
    />

    <!-- ============================ Rencana tab =========================== -->
    <div
      v-if="activeTab === 'plans'"
      class="flex flex-col gap-4"
    >
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <UInput
          v-model="listUserId"
          icon="i-lucide-user"
          placeholder="ID Pengguna (opsional)"
          class="w-full"
        />
        <USelect
          v-model="listMonth"
          :items="listMonthItems"
          value-key="value"
          icon="i-lucide-calendar"
          placeholder="Bulan"
          class="w-full"
        />
        <USelect
          v-model="listYear"
          :items="listYearItems"
          value-key="value"
          icon="i-lucide-calendar-days"
          placeholder="Tahun"
          class="w-full"
        />
        <USelect
          v-model="listApproval"
          :items="approvalItems"
          value-key="value"
          icon="i-lucide-badge-check"
          class="w-full"
        />
      </div>

      <UAlert
        v-if="listError"
        color="error"
        variant="soft"
        icon="i-lucide-circle-alert"
        title="Gagal memuat rencana kunjungan"
        description="Daftar rencana tidak dapat dimuat saat ini. Silakan coba lagi."
      >
        <template #actions>
          <UButton
            color="error"
            variant="outline"
            size="xs"
            label="Coba Lagi"
            @click="refreshList()"
          />
        </template>
      </UAlert>

      <div class="overflow-x-auto rounded-lg border border-default">
        <table class="w-full text-sm">
          <thead class="bg-elevated text-left text-xs font-medium text-muted">
            <tr>
              <th class="px-4 py-2.5">
                Tanggal Rencana
              </th>
              <th class="px-4 py-2.5">
                Pengguna
              </th>
              <th class="px-4 py-2.5">
                Pelanggan
              </th>
              <th class="px-4 py-2.5">
                Sumber
              </th>
              <th class="px-4 py-2.5">
                Status Persetujuan
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-if="listPending"
            >
              <td
                class="px-4 py-6 text-center text-muted"
                colspan="5"
              >
                Memuat…
              </td>
            </tr>
            <tr
              v-else-if="planRows.length === 0"
            >
              <td
                class="px-4 py-6 text-center text-muted"
                colspan="5"
              >
                Tidak ada rencana kunjungan yang cocok.
              </td>
            </tr>
            <tr
              v-for="row in planRows"
              v-else
              :key="row.id"
              class="border-t border-default"
            >
              <td class="px-4 py-2.5 font-medium text-highlighted">
                {{ formatDate(row.plan_date) }}
              </td>
              <td class="px-4 py-2.5 font-mono text-xs text-toned">
                {{ row.user_id }}
              </td>
              <td class="px-4 py-2.5 font-mono text-xs text-toned">
                {{ row.customer_id }}
              </td>
              <td class="px-4 py-2.5">
                <UBadge
                  :color="row.is_lead_from_erp ? 'info' : 'neutral'"
                  variant="soft"
                  size="sm"
                  :label="row.is_lead_from_erp ? 'ERP' : 'Manual'"
                />
              </td>
              <td class="px-4 py-2.5">
                <UBadge
                  :color="row.is_approved ? 'success' : 'warning'"
                  variant="soft"
                  size="sm"
                  :icon="row.is_approved ? 'i-lucide-check' : 'i-lucide-clock'"
                  :label="row.is_approved ? 'Disetujui' : 'Menunggu'"
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="flex flex-wrap items-center justify-between gap-3">
        <p class="text-xs text-dimmed">
          Menampilkan {{ planRows.length }} dari {{ planTotal }} rencana.
        </p>
        <UPagination
          v-if="planTotal > PAGE_LIMIT"
          v-model:page="listPage"
          :items-per-page="PAGE_LIMIT"
          :total="planTotal"
        />
      </div>
    </div>

    <!-- ============================= Unggah tab ============================ -->
    <div
      v-else-if="activeTab === 'upload'"
      class="flex flex-col gap-4"
    >
      <UCard>
        <template #header>
          <h3 class="text-sm font-semibold text-highlighted">
            Impor dari CSV
          </h3>
          <p class="mt-0.5 text-xs text-muted">
            Format kolom: user_id, customer_id, plan_date (YYYY-MM-DD), outlet_context_id (opsional).
          </p>
        </template>

        <div class="flex flex-col gap-3">
          <UTextarea
            v-model="csvInput"
            :rows="4"
            placeholder="u-uuid,cust-uuid,2024-03-05,outlet-uuid"
            class="w-full font-mono text-xs"
          />
          <div>
            <UButton
              icon="i-lucide-file-input"
              color="neutral"
              variant="outline"
              label="Muat dari CSV"
              :disabled="!csvInput.trim()"
              @click="parseCsv"
            />
          </div>
        </div>
      </UCard>

      <UCard>
        <template #header>
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h3 class="text-sm font-semibold text-highlighted">
              Baris Rencana ({{ uploadRows.length }})
            </h3>
            <UButton
              icon="i-lucide-plus"
              color="neutral"
              variant="soft"
              size="xs"
              label="Tambah Baris"
              @click="addRow"
            />
          </div>
        </template>

        <div class="flex flex-col gap-3">
          <div
            v-for="(row, index) in uploadRows"
            :key="index"
            class="grid grid-cols-1 gap-2 sm:grid-cols-12"
          >
            <UInput
              v-model="row.user_id"
              placeholder="user_id (UUID)"
              class="sm:col-span-3"
            />
            <UInput
              v-model="row.customer_id"
              placeholder="customer_id (UUID)"
              class="sm:col-span-3"
            />
            <UInput
              v-model="row.plan_date"
              type="date"
              class="sm:col-span-3"
            />
            <UInput
              v-model="row.outlet_context_id"
              placeholder="outlet_context_id (opsional)"
              class="sm:col-span-2"
            />
            <div class="sm:col-span-1">
              <UButton
                icon="i-lucide-trash-2"
                color="error"
                variant="ghost"
                square
                :aria-label="`Hapus baris ${index + 1}`"
                @click="removeRow(index)"
              />
            </div>
          </div>

          <div class="flex justify-end">
            <UButton
              icon="i-lucide-upload"
              color="primary"
              label="Unggah Rencana"
              :loading="uploading"
              :disabled="!canSubmitUpload || uploading"
              @click="submitUpload"
            />
          </div>
        </div>
      </UCard>

      <UAlert
        v-if="uploadResult"
        :color="uploadResult.errors.length === 0 ? 'success' : 'warning'"
        variant="soft"
        :icon="uploadResult.errors.length === 0 ? 'i-lucide-circle-check' : 'i-lucide-triangle-alert'"
        :title="`${uploadResult.created} rencana berhasil dibuat`"
        :description="uploadResult.errors.length
          ? `${uploadResult.errors.length} baris gagal diproses.`
          : 'Semua baris berhasil diproses.'"
      />

      <div
        v-if="uploadResult && uploadResult.errors.length"
        class="overflow-x-auto rounded-lg border border-default"
      >
        <table class="w-full text-sm">
          <thead class="bg-elevated text-left text-xs font-medium text-muted">
            <tr>
              <th class="px-4 py-2.5">
                Baris
              </th>
              <th class="px-4 py-2.5">
                Kesalahan
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="err in uploadResult.errors"
              :key="err.index"
              class="border-t border-default"
            >
              <td class="px-4 py-2.5 font-medium text-highlighted">
                #{{ err.index + 1 }}
              </td>
              <td class="px-4 py-2.5 text-toned">
                {{ err.message }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- =========================== Analitik tab ========================== -->
    <div
      v-else
      class="flex flex-col gap-4"
    >
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <USelect
          v-model="analyticsMonth"
          :items="monthItems"
          value-key="value"
          icon="i-lucide-calendar"
          class="w-full"
        />
        <USelect
          v-model="analyticsYear"
          :items="yearItems"
          value-key="value"
          icon="i-lucide-calendar-days"
          class="w-full"
        />
        <USelect
          v-model="analyticsRole"
          :items="roleItems"
          value-key="value"
          icon="i-lucide-users"
          class="w-full"
        />
      </div>

      <UAlert
        v-if="analyticsError"
        color="error"
        variant="soft"
        icon="i-lucide-circle-alert"
        title="Gagal memuat analitik call rate"
        description="Data analitik tidak dapat dimuat saat ini. Silakan coba lagi."
      >
        <template #actions>
          <UButton
            color="error"
            variant="outline"
            size="xs"
            label="Coba Lagi"
            @click="refreshAnalytics()"
          />
        </template>
      </UAlert>

      <!-- Summary cards: Salesman vs MR call rate -->
      <UCard v-if="salesmanSummary && mrSummary">
        <template #header>
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h3 class="text-sm font-semibold text-highlighted">
              Call Rate — Salesman vs MR
            </h3>
            <div class="flex items-center gap-4 text-xs text-muted">
              <span class="flex items-center gap-1.5">
                <span class="size-2.5 rounded-full bg-primary-500" />
                Salesman
              </span>
              <span class="flex items-center gap-1.5">
                <span class="size-2.5 rounded-full bg-warning-500" />
                MR
              </span>
            </div>
          </div>
        </template>

        <div class="flex flex-col gap-5">
          <RoleComparisonBar
            label="Total Rencana"
            :salesman="salesmanSummary.total_planned"
            :mr="mrSummary.total_planned"
          />
          <RoleComparisonBar
            label="Total Kunjungan"
            :salesman="salesmanSummary.total_visited"
            :mr="mrSummary.total_visited"
          />
          <RoleComparisonBar
            label="Call Rate"
            :salesman="salesmanSummary.call_rate_pct"
            :mr="mrSummary.call_rate_pct"
            suffix="%"
          />
        </div>
      </UCard>

      <!-- Per-user call-rate table -->
      <div class="overflow-x-auto rounded-lg border border-default">
        <table class="w-full text-sm">
          <thead class="bg-elevated text-left text-xs font-medium text-muted">
            <tr>
              <th class="px-4 py-2.5">
                Pengguna
              </th>
              <th class="px-4 py-2.5">
                Peran
              </th>
              <th class="px-4 py-2.5 text-right">
                Direncanakan
              </th>
              <th class="px-4 py-2.5 text-right">
                Dikunjungi
              </th>
              <th class="px-4 py-2.5 text-right">
                Call Rate
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="analyticsPending">
              <td
                class="px-4 py-6 text-center text-muted"
                colspan="5"
              >
                Memuat…
              </td>
            </tr>
            <tr v-else-if="analyticsRows.length === 0">
              <td
                class="px-4 py-6 text-center text-muted"
                colspan="5"
              >
                Tidak ada data call rate untuk periode ini.
              </td>
            </tr>
            <tr
              v-for="entry in analyticsRows"
              v-else
              :key="entry.user_id"
              class="border-t border-default"
            >
              <td class="px-4 py-2.5 font-medium text-highlighted">
                {{ entry.user_name }}
              </td>
              <td class="px-4 py-2.5">
                <UBadge
                  :color="entry.role_label === 'SALESMAN' ? 'primary' : 'warning'"
                  variant="soft"
                  size="sm"
                  :label="entry.role_label"
                />
              </td>
              <td class="px-4 py-2.5 text-right tabular-nums text-toned">
                {{ entry.total_planned }}
              </td>
              <td class="px-4 py-2.5 text-right tabular-nums text-toned">
                {{ entry.total_visited }}
              </td>
              <td class="px-4 py-2.5 text-right font-semibold tabular-nums text-highlighted">
                {{ entry.call_rate_pct.toFixed(1) }}%
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
