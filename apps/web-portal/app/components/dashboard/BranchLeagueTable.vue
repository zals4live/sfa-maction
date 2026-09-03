<script setup lang="ts">
/**
 * `BranchLeagueTable` — the branch performance league table (leaderboard) for the dashboard.
 *
 * Where the reporting-center `BranchPerformanceTable` is a static comparative matrix keyed
 * on the backend's overall `rank`, this dashboard component is a *leaderboard*: an internal
 * segment toggle (Overall / Salesman / MR) re-ranks the branches by the selected segment so
 * an admin can read the standings for either field role, not just the blended figure. The
 * chosen segment drives both the ranking order and the emphasized call-rate column; the top
 * three positions carry medal accents drawn from the Nuxt UI semantic palette.
 *
 * Presentation-only: rows come from `GET /reports/branch-performance` via {@link useReporting}
 * upstream. The page owns fetching, period selection, and error handling; this component only
 * ranks and shapes the rows. A `loading` flag renders the table skeleton to preserve layout.
 *
 * Forced Light Mode is global (nuxt.config `colorMode`) — no dark-mode classes or `dark:`
 * variants here.
 */
import { h } from 'vue'
import type { TableColumn } from '@nuxt/ui'
import type { BranchPerformanceRow } from '~/composables/useReporting'

/** Which segment the league table ranks by. Empty is the blended "Overall" standing. */
export type LeagueSegment = '' | 'SALESMAN' | 'MR'

const props = withDefaults(
  defineProps<{
    /** Rows resolved from `/reports/branch-performance` (any incoming order). */
    rows: BranchPerformanceRow[]
    /** Whether the parent fetch is in flight (drives the table skeleton). */
    loading?: boolean
    /** Optional card title override. */
    title?: string
  }>(),
  {
    loading: false,
    title: 'Klasemen Kinerja Cabang'
  }
)

/** Active ranking segment; drives both order and the emphasized call-rate column. */
const segment = ref<LeagueSegment>('')

const segmentItems = [
  { label: 'Keseluruhan', value: '' as LeagueSegment },
  { label: 'Salesman', value: 'SALESMAN' as LeagueSegment },
  { label: 'MR', value: 'MR' as LeagueSegment }
]

/** Format a rupiah amount as a compact currency string (no fractional cents). */
function formatCurrency(value: number): string {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0
  }).format(value)
}

/** Format an integer with Indonesian locale grouping. */
function formatCount(value: number): string {
  return value.toLocaleString('id-ID')
}

/** The score a row is ranked by for the active segment (call rate % of that segment). */
function segmentScore(row: BranchPerformanceRow, seg: LeagueSegment): number {
  if (seg === 'SALESMAN') return row.SALESMAN.call_rate_pct
  if (seg === 'MR') return row.MR.call_rate_pct
  return row.strike_rate_pct
}

/**
 * Rows re-ranked for the active segment: sorted descending by the segment score, then
 * assigned a fresh 1-based standing. For the blended "Overall" segment we honor the
 * backend's own `rank` so the leaderboard matches the report-center matrix.
 */
const rankedRows = computed<BranchPerformanceRow[]>(() => {
  if (segment.value === '') {
    return [...props.rows].sort((a, b) => a.rank - b.rank)
  }
  const seg = segment.value
  return [...props.rows]
    .sort((a, b) => segmentScore(b, seg) - segmentScore(a, seg))
    .map((row, index) => ({ ...row, rank: index + 1 }))
})

/** Medal accent classes for the top three standings; plain muted text below. */
const MEDAL_CLASSES: Record<number, string> = {
  1: 'bg-warning-100 text-warning-700',
  2: 'bg-elevated text-muted',
  3: 'bg-primary-50 text-primary-600'
}

/** Label for the segment-scoped score column header. */
const scoreHeader = computed<string>(() =>
  segment.value === '' ? 'Strike Rate' : 'Call Rate'
)

const columns = computed<TableColumn<BranchPerformanceRow>[]>(() => [
  {
    accessorKey: 'rank',
    header: '#',
    cell: ({ row }) => {
      const rank = row.original.rank
      const medal = MEDAL_CLASSES[rank]
      return h(
        'span',
        {
          class: [
            'inline-flex size-6 items-center justify-center rounded-full text-xs font-semibold tabular-nums',
            medal ?? 'text-muted'
          ]
        },
        rank
      )
    }
  },
  {
    accessorKey: 'soffice_name',
    header: 'Cabang',
    cell: ({ row }) => h('span', { class: 'font-medium text-highlighted' }, row.original.soffice_name)
  },
  {
    accessorKey: 'total_visits',
    header: () => h('div', { class: 'text-right' }, 'Kunjungan'),
    cell: ({ row }) =>
      h('div', { class: 'text-right tabular-nums' }, formatCount(row.original.total_visits))
  },
  {
    accessorKey: 'total_revenue',
    header: () => h('div', { class: 'text-right' }, 'Pendapatan'),
    cell: ({ row }) =>
      h(
        'div',
        { class: 'text-right font-semibold tabular-nums text-highlighted' },
        formatCurrency(row.original.total_revenue)
      )
  },
  {
    id: 'segment_score',
    header: () => h('div', { class: 'text-right' }, scoreHeader.value),
    cell: ({ row }) => {
      const score = segmentScore(row.original, segment.value)
      const accent
        = segment.value === 'SALESMAN'
          ? 'text-primary-600'
          : segment.value === 'MR'
            ? 'text-warning-600'
            : 'text-highlighted'
      return h(
        'div',
        { class: ['text-right font-semibold tabular-nums', accent] },
        `${score.toFixed(1)}%`
      )
    }
  }
])
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h3 class="text-sm font-semibold text-highlighted">
          {{ props.title }}
        </h3>
        <UFieldGroup size="xs">
          <UButton
            v-for="item in segmentItems"
            :key="item.value"
            :label="item.label"
            :color="segment === item.value ? 'primary' : 'neutral'"
            :variant="segment === item.value ? 'solid' : 'outline'"
            @click="segment = item.value"
          />
        </UFieldGroup>
      </div>
    </template>

    <UTable
      :data="rankedRows"
      :columns="columns"
      :loading="props.loading"
      loading-color="primary"
      empty="Tidak ada data kinerja cabang untuk periode ini."
      :ui="{ td: 'text-sm text-muted' }"
    />
  </UCard>
</template>
