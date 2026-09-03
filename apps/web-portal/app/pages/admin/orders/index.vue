<script setup lang="ts">
/**
 * `/admin/orders` — order approval/review register for the web-portal admin roles.
 *
 * Renders a filterable, paginated review table over the tenant's orders sourced from
 * `GET /orders` via {@link useOrders}. Because order-taking is a `SALESMAN`-exclusive surface
 * (MR is blocked server-side), every row is implicitly a Salesman order — the page states this
 * explicitly rather than offering a role filter that would always be a no-op.
 *
 * Filters (all server-driven, mirroring the backend `ListOrdersQuery`): lifecycle status,
 * order date range (from/to), and customer id. The list is a server-driven fetch keyed on the
 * filter refs (page, status, dates, customer) so every filter change re-queries the backend —
 * the table itself does no client-side filtering or pagination. Each row links to the
 * `/admin/orders/:id` detail/review view where the approve (submit-to-ERP) action lives.
 *
 * Access is gated by the `auth` middleware (ADMIN_CABANG / ADMIN_PUSAT / SUPER_ADMIN); the
 * backend independently enforces the same boundary via tenant + role guards. Forced Light Mode
 * is global — no dark-mode classes or `dark:` variants.
 */
import { computed, h, resolveComponent, ref, watch } from 'vue'
import type { SelectItem, TableColumn } from '@nuxt/ui'
import {
  useOrders,
  type ListOrdersQuery,
  type OrderListResponse,
  type OrderResponse,
  type OrderStatusValue
} from '~/composables/useOrders'
import OrderStatusBadge from '~/components/order/OrderStatusBadge.vue'

definePageMeta({
  layout: 'default',
  middleware: 'auth'
})

useHead({ title: 'Persetujuan Pesanan — KF Maction Admin' })

const orders = useOrders()

const UButton = resolveComponent('UButton')
const NuxtLink = resolveComponent('NuxtLink')

/** Page size for the paginated list (matches the backend default). */
const PAGE_LIMIT = 20

// --- Filter state (drives the server query) ---
const page = ref<number>(1)
const statusFilter = ref<'' | OrderStatusValue>('')
const dateFrom = ref<string>('')
const dateTo = ref<string>('')
const customerFilter = ref<string>('')

const statusItems: SelectItem[] = [
  { label: 'Semua Status', value: '' },
  { label: 'Draft', value: 'DRAFT' },
  { label: 'Diajukan', value: 'SUBMITTED' },
  { label: 'Tersinkron ERP', value: 'SYNCED_ERP' },
  { label: 'Ditolak ERP', value: 'REJECTED_ERP' },
  { label: 'Dibatalkan', value: 'CANCELLED' }
]

// Any filter change (except page) resets to the first page so results stay coherent.
watch([statusFilter, dateFrom, dateTo, customerFilter], () => {
  page.value = 1
})

/** Build the backend query from the active filter refs, dropping empty selections. */
function buildQuery(): ListOrdersQuery {
  const query: ListOrdersQuery = { page: page.value, limit: PAGE_LIMIT }
  if (statusFilter.value) query.status = statusFilter.value
  if (dateFrom.value) query.date_from = dateFrom.value
  if (dateTo.value) query.date_to = dateTo.value
  if (customerFilter.value.trim()) query.customer_id = customerFilter.value.trim()
  return query
}

// SSR-friendly fetch keyed on all filter refs — refetches on any change.
const { data, pending, error, refresh } = await useAsyncData<OrderListResponse>(
  'admin-orders',
  () => orders.listOrders(buildQuery()),
  { watch: [page, statusFilter, dateFrom, dateTo, customerFilter] }
)

const rows = computed<OrderResponse[]>(() => data.value?.data ?? [])
const total = computed<number>(() => data.value?.meta.total ?? 0)

/** Reset every filter back to its default and return to the first page. */
function clearFilters(): void {
  statusFilter.value = ''
  dateFrom.value = ''
  dateTo.value = ''
  customerFilter.value = ''
  page.value = 1
}

const hasActiveFilters = computed<boolean>(() =>
  Boolean(statusFilter.value || dateFrom.value || dateTo.value || customerFilter.value.trim())
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

const columns: TableColumn<OrderResponse>[] = [
  {
    accessorKey: 'order_number',
    header: 'No. Pesanan',
    cell: ({ row }) =>
      h(
        NuxtLink,
        {
          to: `/admin/orders/${row.original.id}`,
          class: 'font-medium text-primary hover:underline'
        },
        () => row.original.order_number
      )
  },
  {
    accessorKey: 'order_date',
    header: 'Tanggal',
    cell: ({ row }) => formatDate(row.original.order_date)
  },
  {
    accessorKey: 'erp_quotation_number',
    header: 'No. Kuotasi ERP',
    cell: ({ row }) =>
      h('span', { class: 'font-mono text-xs text-toned' }, row.original.erp_quotation_number ?? '—')
  },
  {
    accessorKey: 'grand_total',
    header: () => h('div', { class: 'text-right' }, 'Total'),
    cell: ({ row }) =>
      h(
        'div',
        { class: 'text-right font-semibold tabular-nums text-highlighted' },
        formatCurrency(row.original.grand_total)
      )
  },
  {
    accessorKey: 'order_status',
    header: 'Status',
    cell: ({ row }) => h(OrderStatusBadge, { status: row.original.order_status })
  },
  {
    id: 'actions',
    header: () => h('div', { class: 'text-right' }, 'Aksi'),
    cell: ({ row }) =>
      h('div', { class: 'flex justify-end gap-1' }, [
        h(UButton, {
          'icon': 'i-lucide-eye',
          'color': 'neutral',
          'variant': 'ghost',
          'size': 'sm',
          'to': `/admin/orders/${row.original.id}`,
          'aria-label': 'Tinjau pesanan'
        })
      ])
  }
]
</script>

<template>
  <div class="flex flex-col gap-6 p-4 sm:p-6">
    <!-- Header -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold text-highlighted">
          Persetujuan Pesanan
        </h1>
        <p class="mt-0.5 text-sm text-muted">
          Tinjau &amp; setujui pesanan Salesman untuk sinkronisasi ke ERP.
        </p>
      </div>
      <UBadge
        color="primary"
        variant="subtle"
        size="sm"
        icon="i-lucide-briefcase"
        label="Pesanan Salesman"
      />
    </div>

    <!-- Filters -->
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <USelect
        v-model="statusFilter"
        :items="statusItems"
        value-key="value"
        icon="i-lucide-badge-check"
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
        v-model="customerFilter"
        icon="i-lucide-store"
        placeholder="ID Pelanggan (opsional)"
        class="w-full"
      />
    </div>

    <div
      v-if="hasActiveFilters"
      class="-mt-2"
    >
      <UButton
        icon="i-lucide-x"
        color="neutral"
        variant="ghost"
        size="xs"
        label="Bersihkan filter"
        @click="clearFilters"
      />
    </div>

    <!-- Error banner -->
    <UAlert
      v-if="error"
      color="error"
      variant="soft"
      icon="i-lucide-circle-alert"
      title="Gagal memuat data pesanan"
      description="Daftar pesanan tidak dapat dimuat saat ini. Silakan coba lagi."
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

    <!-- Data table -->
    <UTable
      :data="rows"
      :columns="columns"
      :loading="pending"
      loading-color="primary"
      empty="Tidak ada pesanan yang cocok."
      :ui="{ td: 'text-sm text-muted' }"
    />

    <!-- Pagination footer -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <p class="text-xs text-dimmed">
        Menampilkan {{ rows.length }} dari {{ total }} pesanan.
      </p>
      <UPagination
        v-if="total > PAGE_LIMIT"
        v-model:page="page"
        :items-per-page="PAGE_LIMIT"
        :total="total"
      />
    </div>
  </div>
</template>
