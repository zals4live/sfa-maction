<script setup lang="ts">
/**
 * `OrderRegisterTable` — the order / quotation transaction register for the reporting center.
 *
 * Presentation-only: it renders one row per order from `GET /reports/orders`, showing the
 * order number, owning salesman, customer, status, total, and creation date. Because
 * order-taking is a `SALESMAN`-exclusive surface (MR is blocked server-side), the register
 * only ever contains Salesman transactions — no role column is needed. Filtering and
 * pagination live in the page; this component only shapes the returned rows.
 *
 * Order status is rendered via the shared {@link OrderStatusBadge}. Forced Light Mode is
 * global — no dark-mode classes or `dark:` variants here.
 */
import { h } from 'vue'
import type { TableColumn } from '@nuxt/ui'
import type { OrderRegisterRow } from '~/composables/useReporting'
import type { OrderStatusValue } from '~/composables/useOrders'
import OrderStatusBadge from '~/components/order/OrderStatusBadge.vue'

const props = withDefaults(
  defineProps<{
    /** Rows resolved from `/reports/orders`. */
    rows: OrderRegisterRow[]
    /** Whether the parent fetch is in flight (drives the table skeleton). */
    loading?: boolean
  }>(),
  {
    loading: false
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

/** Format an ISO/date string as a compact Indonesian date. */
function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' })
}

const columns: TableColumn<OrderRegisterRow>[] = [
  {
    accessorKey: 'order_number',
    header: 'No. Pesanan',
    cell: ({ row }) =>
      h(
        resolveComponent('NuxtLink'),
        {
          to: `/admin/orders/${row.original.order_id}`,
          class: 'font-medium text-primary hover:underline'
        },
        () => row.original.order_number
      )
  },
  {
    accessorKey: 'created_at',
    header: 'Tanggal',
    cell: ({ row }) => formatDate(row.original.created_at)
  },
  {
    accessorKey: 'customer_id',
    header: 'Pelanggan',
    cell: ({ row }) => h('span', { class: 'font-mono text-xs text-toned' }, row.original.customer_id)
  },
  {
    accessorKey: 'total_amount',
    header: () => h('div', { class: 'text-right' }, 'Total'),
    cell: ({ row }) =>
      h(
        'div',
        { class: 'text-right font-semibold tabular-nums text-highlighted' },
        formatCurrency(row.original.total_amount)
      )
  },
  {
    accessorKey: 'status',
    header: 'Status',
    cell: ({ row }) => h(OrderStatusBadge, { status: row.original.status as OrderStatusValue })
  }
]
</script>

<template>
  <UTable
    :data="props.rows"
    :columns="columns"
    :loading="props.loading"
    loading-color="primary"
    empty="Tidak ada transaksi pesanan untuk filter ini."
    :ui="{ td: 'text-sm text-muted' }"
  />
</template>
