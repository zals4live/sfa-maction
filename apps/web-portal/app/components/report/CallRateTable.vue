<script setup lang="ts">
/**
 * `CallRateTable` — the per-user call-rate report for the reporting center.
 *
 * Presentation-only: it renders one row per field user from `GET /reports/call-rate`,
 * showing planned vs visited counts and the resulting call rate, with a role badge so a
 * combined Salesman + MR view stays legible. Role scoping is applied server-side by the
 * page (via the `role` query param); this component only shapes the returned rows.
 *
 * Forced Light Mode is global — no dark-mode classes or `dark:` variants here.
 */
import { h } from 'vue'
import type { TableColumn } from '@nuxt/ui'
import type { CallRateRow } from '~/composables/useReporting'

const props = withDefaults(
  defineProps<{
    /** Rows resolved from `/reports/call-rate`. */
    rows: CallRateRow[]
    /** Whether the parent fetch is in flight (drives the table skeleton). */
    loading?: boolean
  }>(),
  {
    loading: false
  }
)

/** Format an integer with Indonesian locale grouping. */
function formatCount(value: number): string {
  return value.toLocaleString('id-ID')
}

const columns: TableColumn<CallRateRow>[] = [
  {
    accessorKey: 'user_name',
    header: 'Pengguna',
    cell: ({ row }) => h('span', { class: 'font-medium text-highlighted' }, row.original.user_name)
  },
  {
    accessorKey: 'role_label',
    header: 'Role',
    cell: ({ row }) => {
      const isSalesman = row.original.role_label === 'SALESMAN'
      return h(
        resolveComponent('UBadge'),
        {
          color: isSalesman ? 'primary' : 'warning',
          variant: 'subtle',
          size: 'sm',
          label: isSalesman ? 'Salesman' : 'MR'
        }
      )
    }
  },
  {
    accessorKey: 'total_planned',
    header: () => h('div', { class: 'text-right' }, 'Rencana'),
    cell: ({ row }) =>
      h('div', { class: 'text-right tabular-nums' }, formatCount(row.original.total_planned))
  },
  {
    accessorKey: 'total_visited',
    header: () => h('div', { class: 'text-right' }, 'Terealisasi'),
    cell: ({ row }) =>
      h('div', { class: 'text-right tabular-nums' }, formatCount(row.original.total_visited))
  },
  {
    accessorKey: 'call_rate_pct',
    header: () => h('div', { class: 'text-right' }, 'Call Rate'),
    cell: ({ row }) =>
      h(
        'div',
        { class: 'text-right font-semibold tabular-nums text-highlighted' },
        `${row.original.call_rate_pct.toFixed(1)}%`
      )
  }
]
</script>

<template>
  <UTable
    :data="props.rows"
    :columns="columns"
    :loading="props.loading"
    loading-color="primary"
    empty="Tidak ada data call rate untuk filter ini."
    :ui="{ td: 'text-sm text-muted' }"
  />
</template>
