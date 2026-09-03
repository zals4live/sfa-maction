<script setup lang="ts">
/**
 * `BranchPerformanceTable` — the branch performance matrix for the reporting center.
 *
 * Presentation-only: it renders one ranked row per sales office from
 * `GET /reports/branch-performance`, exposing the headline branch figures (visits,
 * revenue, strike rate) alongside the Salesman-vs-MR segmented call rates the backend
 * returns per branch. Data fetching, filtering, and role-scoping decisions live in the
 * page; this component just shapes the rows into columns.
 *
 * When a single role is selected upstream, the page can hide the counterpart's column
 * via `roleFilter`; by default both role columns show so the matrix stays comparative.
 *
 * Forced Light Mode is global — no dark-mode classes or `dark:` variants here.
 */
import { h } from 'vue'
import type { TableColumn } from '@nuxt/ui'
import type { BranchPerformanceRow } from '~/composables/useReporting'
import type { RoleFilterValue } from './ReportFilters.vue'

const props = withDefaults(
  defineProps<{
    /** Rows resolved from `/reports/branch-performance`. */
    rows: BranchPerformanceRow[]
    /** Whether the parent fetch is in flight (drives the table skeleton). */
    loading?: boolean
    /** Active role filter; hides the counterpart call-rate column when set. */
    roleFilter?: RoleFilterValue
  }>(),
  {
    loading: false,
    roleFilter: ''
  }
)

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

const columns = computed<TableColumn<BranchPerformanceRow>[]>(() => {
  const base: TableColumn<BranchPerformanceRow>[] = [
    {
      accessorKey: 'rank',
      header: '#',
      cell: ({ row }) => h('span', { class: 'font-semibold text-muted tabular-nums' }, row.original.rank)
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
      accessorKey: 'strike_rate_pct',
      header: () => h('div', { class: 'text-right' }, 'Strike Rate'),
      cell: ({ row }) =>
        h('div', { class: 'text-right tabular-nums' }, `${row.original.strike_rate_pct.toFixed(1)}%`)
    }
  ]

  const salesmanCol: TableColumn<BranchPerformanceRow> = {
    id: 'salesman_call_rate',
    header: () => h('div', { class: 'text-right text-primary-600' }, 'CR Salesman'),
    cell: ({ row }) =>
      h('div', { class: 'text-right tabular-nums' }, `${row.original.SALESMAN.call_rate_pct.toFixed(1)}%`)
  }

  const mrCol: TableColumn<BranchPerformanceRow> = {
    id: 'mr_call_rate',
    header: () => h('div', { class: 'text-right text-warning-600' }, 'CR MR'),
    cell: ({ row }) =>
      h('div', { class: 'text-right tabular-nums' }, `${row.original.MR.call_rate_pct.toFixed(1)}%`)
  }

  if (props.roleFilter === 'SALESMAN') return [...base, salesmanCol]
  if (props.roleFilter === 'MR') return [...base, mrCol]
  return [...base, salesmanCol, mrCol]
})
</script>

<template>
  <UTable
    :data="props.rows"
    :columns="columns"
    :loading="props.loading"
    loading-color="primary"
    empty="Tidak ada data kinerja cabang untuk periode ini."
    :ui="{ td: 'text-sm text-muted' }"
  />
</template>
