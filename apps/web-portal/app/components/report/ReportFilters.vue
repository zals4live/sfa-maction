<script setup lang="ts">
/**
 * `ReportFilters` — the shared filter bar for the reporting center (`/admin/reports`).
 *
 * Presentation-only: it renders the three cross-report controls (date range, branch /
 * sales-office, and field role) and emits the selected values up to the page via
 * `v-model`. The page owns the state and decides which controls are relevant for the
 * active report tab — this component simply toggles a control's visibility through the
 * `show*` flags so, for example, the branch-performance tab (which the backend keys on
 * month/year only) can hide the day-level date inputs.
 *
 * The branch filter mirrors the pattern used by the orders register: a free-text
 * sales-office id input rather than a select, because the portal exposes no soffice-list
 * endpoint yet. Role is a bounded Salesman/MR/both select.
 *
 * Forced Light Mode is global — no dark-mode classes or `dark:` variants here.
 */
import type { SelectItem } from '@nuxt/ui'

/** Role filter literal: empty string means "both Salesman & MR". */
export type RoleFilterValue = '' | 'SALESMAN' | 'MR'

const props = withDefaults(
  defineProps<{
    /** Show the day-level date range inputs (from / to). */
    showDateRange?: boolean
    /** Show the month / year inputs (period-based reports). */
    showMonthYear?: boolean
    /** Show the branch (sales-office id) input. */
    showBranch?: boolean
    /** Show the role select. */
    showRole?: boolean
  }>(),
  {
    showDateRange: true,
    showMonthYear: false,
    showBranch: true,
    showRole: true
  }
)

// Two-way bound filter values. Undefined-safe defaults keep the controls controlled.
const dateFrom = defineModel<string>('dateFrom', { default: '' })
const dateTo = defineModel<string>('dateTo', { default: '' })
const month = defineModel<number>('month', { default: () => new Date().getMonth() + 1 })
const year = defineModel<number>('year', { default: () => new Date().getFullYear() })
const sofficeId = defineModel<string>('sofficeId', { default: '' })
const role = defineModel<RoleFilterValue>('role', { default: '' })

const roleItems: SelectItem[] = [
  { label: 'Semua Role', value: '' },
  { label: 'Salesman', value: 'SALESMAN' },
  { label: 'MR', value: 'MR' }
]

/** Month options (1–12) with Indonesian long-form labels for the month/year reports. */
const monthItems = computed<SelectItem[]>(() =>
  Array.from({ length: 12 }, (_, i) => ({
    label: new Date(2000, i, 1).toLocaleDateString('id-ID', { month: 'long' }),
    value: i + 1
  }))
)

/** Year options: the current year and the four prior years. */
const yearItems = computed<SelectItem[]>(() => {
  const current = new Date().getFullYear()
  return Array.from({ length: 5 }, (_, i) => ({ label: String(current - i), value: current - i }))
})

/** Whether any filter currently deviates from its default (drives the clear button). */
const hasActiveFilters = computed<boolean>(() => {
  const dateActive = props.showDateRange && Boolean(dateFrom.value || dateTo.value)
  const branchActive = props.showBranch && Boolean(sofficeId.value.trim())
  const roleActive = props.showRole && Boolean(role.value)
  return dateActive || branchActive || roleActive
})

/** Reset the visible filters back to their defaults (month/year keep the current period). */
function clearFilters(): void {
  dateFrom.value = ''
  dateTo.value = ''
  sofficeId.value = ''
  role.value = ''
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <UInput
        v-if="showDateRange"
        v-model="dateFrom"
        type="date"
        icon="i-lucide-calendar"
        aria-label="Tanggal mulai"
        class="w-full"
      />
      <UInput
        v-if="showDateRange"
        v-model="dateTo"
        type="date"
        icon="i-lucide-calendar-days"
        aria-label="Tanggal akhir"
        class="w-full"
      />

      <USelect
        v-if="showMonthYear"
        v-model="month"
        :items="monthItems"
        value-key="value"
        icon="i-lucide-calendar"
        aria-label="Bulan"
        class="w-full"
      />
      <USelect
        v-if="showMonthYear"
        v-model="year"
        :items="yearItems"
        value-key="value"
        icon="i-lucide-calendar-range"
        aria-label="Tahun"
        class="w-full"
      />

      <UInput
        v-if="showBranch"
        v-model="sofficeId"
        icon="i-lucide-building-2"
        placeholder="ID Cabang / Soffice (opsional)"
        aria-label="ID cabang"
        class="w-full"
      />

      <USelect
        v-if="showRole"
        v-model="role"
        :items="roleItems"
        value-key="value"
        icon="i-lucide-users"
        aria-label="Filter role"
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
</template>
