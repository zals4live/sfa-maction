<script setup lang="ts">
/**
 * `RoleSegmentedChart` — the Salesman-vs-MR activity chart card for the dashboard.
 *
 * Composes a titled `UCard` with a color legend and one {@link RoleComparisonBar} per
 * segmented metric (total visits, effective calls, call rate). It maps the two
 * `RoleMetrics` blocks returned by `/reports/dashboard-kpi` into comparison rows, so the
 * page passes the API response straight through without reshaping. A `loading` flag
 * swaps the rows for skeletons to preserve layout during the initial fetch.
 *
 * Forced Light Mode is global — no dark-mode classes or `dark:` variants here.
 */
import type { RoleMetrics } from '~/composables/useReporting'
import RoleComparisonBar from './RoleComparisonBar.vue'

const props = withDefaults(
  defineProps<{
    /** Salesman aggregate metrics for the active period. */
    salesman: RoleMetrics
    /** MR aggregate metrics for the active period. */
    mr: RoleMetrics
    /** Render skeleton rows instead of live bars. */
    loading?: boolean
  }>(),
  {
    loading: false
  }
)

/** The segmented rows rendered in the chart, in display order. */
const rows = computed(() => [
  { label: 'Total Kunjungan', salesman: props.salesman.total_visits, mr: props.mr.total_visits, suffix: '' },
  { label: 'Effective Calls', salesman: props.salesman.effective_calls, mr: props.mr.effective_calls, suffix: '' },
  { label: 'Call Rate', salesman: props.salesman.call_rate_pct, mr: props.mr.call_rate_pct, suffix: '%' }
])
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h3 class="text-sm font-semibold text-highlighted">
          Aktivitas Lapangan — Salesman vs MR
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

    <div
      v-if="loading"
      class="flex flex-col gap-5"
    >
      <div
        v-for="n in 3"
        :key="n"
        class="flex flex-col gap-2"
      >
        <USkeleton class="h-4 w-28" />
        <USkeleton class="h-2.5 w-full" />
        <USkeleton class="h-2.5 w-3/4" />
      </div>
    </div>

    <div
      v-else
      class="flex flex-col gap-5"
    >
      <RoleComparisonBar
        v-for="row in rows"
        :key="row.label"
        :label="row.label"
        :salesman="row.salesman"
        :mr="row.mr"
        :suffix="row.suffix"
      />
    </div>
  </UCard>
</template>
