<script setup lang="ts">
/**
 * `/admin/customers` — customer master-data management for the web-portal admin roles.
 *
 * Renders a searchable, filterable, paginated CRUD table over the tenant's customers (both
 * Outlet and Doctor types, plus Community/Event) sourced from `GET /customers` via
 * {@link useCustomers}. Create and edit flow through a shared `CustomerFormModal`; delete is
 * a soft-delete confirmed in a second modal. The list is a server-driven fetch keyed on the
 * filter refs (page, search, type, active, city) so every filter change re-queries the
 * backend — the table itself does no client-side filtering or pagination.
 *
 * Access is gated by the `auth` middleware (ADMIN_CABANG / ADMIN_PUSAT / SUPER_ADMIN); the
 * backend independently enforces the same boundary via tenant + role guards. Forced Light
 * Mode is global, so this page uses no dark-mode classes or `dark:` variants.
 */
import { computed, h, ref, resolveComponent, watch } from 'vue'
import type { SelectItem, TableColumn } from '@nuxt/ui'
import {
  useCustomers,
  type CreateCustomerInput,
  type CustomerListResponse,
  type CustomerResponse,
  type CustomerTypeValue,
  type ListCustomersQuery,
  type UpdateCustomerInput
} from '~/composables/useCustomers'
import CustomerFormModal from '~/components/customer/CustomerFormModal.vue'

definePageMeta({
  layout: 'default',
  middleware: 'auth'
})

useHead({ title: 'Pelanggan — KF Maction Admin' })

const customers = useCustomers()
const toast = useToast()

const UBadge = resolveComponent('UBadge')
const UButton = resolveComponent('UButton')
const NuxtLink = resolveComponent('NuxtLink')

/** Page size for the paginated list (matches the backend default). */
const PAGE_LIMIT = 20

/** Debounce window (ms) before a keystroke triggers a search refetch. */
const SEARCH_DEBOUNCE_MS = 400

// --- Filter state (drives the server query) ---
const page = ref<number>(1)
const searchInput = ref<string>('')
const search = ref<string>('')
const typeFilter = ref<CustomerTypeValue | ''>('')
const activeFilter = ref<'' | 'true' | 'false'>('')
const cityFilter = ref<string>('')

const typeItems: SelectItem[] = [
  { label: 'Semua Tipe', value: '' },
  { label: 'Outlet', value: 'OUTLET' },
  { label: 'Dokter', value: 'DOCTOR' },
  { label: 'Komunitas', value: 'COMMUNITY' },
  { label: 'Event', value: 'EVENT' }
]

const activeItems: SelectItem[] = [
  { label: 'Semua Status', value: '' },
  { label: 'Aktif', value: 'true' },
  { label: 'Nonaktif', value: 'false' }
]

// --- Debounced search: mirror the input into the query ref after a quiet window. ---
let searchTimer: ReturnType<typeof setTimeout> | null = null
watch(searchInput, (value) => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    search.value = value.trim()
  }, SEARCH_DEBOUNCE_MS)
})

// Any filter change (except page) resets to the first page so results stay coherent.
watch([search, typeFilter, activeFilter, cityFilter], () => {
  page.value = 1
})

/** Build the backend query from the active filter refs, dropping empty selections. */
function buildQuery(): ListCustomersQuery {
  const query: ListCustomersQuery = { page: page.value, limit: PAGE_LIMIT }
  if (search.value) query.search = search.value
  if (typeFilter.value) query.customer_type = typeFilter.value
  if (activeFilter.value) query.is_active = activeFilter.value === 'true'
  if (cityFilter.value.trim()) query.city = cityFilter.value.trim()
  return query
}

// SSR-friendly fetch keyed on all filter refs — refetches on any change.
const { data, pending, error, refresh } = await useAsyncData<CustomerListResponse>(
  'admin-customers',
  () => customers.listCustomers(buildQuery()),
  { watch: [page, search, typeFilter, activeFilter, cityFilter] }
)

const rows = computed<CustomerResponse[]>(() => data.value?.data ?? [])
const total = computed<number>(() => data.value?.meta.total ?? 0)

// --- Modal state ---
const isFormOpen = ref<boolean>(false)
const editing = ref<CustomerResponse | null>(null)
const isDeleteOpen = ref<boolean>(false)
const deleting = ref<CustomerResponse | null>(null)
const mutating = ref<boolean>(false)

/** Open the form in create mode. */
function openCreate(): void {
  editing.value = null
  isFormOpen.value = true
}

/** Open the form in edit mode for a given row. */
function openEdit(customer: CustomerResponse): void {
  editing.value = customer
  isFormOpen.value = true
}

/** Open the delete confirmation for a given row. */
function openDelete(customer: CustomerResponse): void {
  deleting.value = customer
  isDeleteOpen.value = true
}

/** Persist a new customer, then close the form and refresh the list. */
async function onCreate(payload: CreateCustomerInput): Promise<void> {
  mutating.value = true
  try {
    await customers.createCustomer(payload)
    isFormOpen.value = false
    toast.add({ title: 'Pelanggan ditambahkan', color: 'success' })
    await refresh()
  } catch {
    toast.add({ title: 'Gagal menambahkan pelanggan', color: 'error' })
  } finally {
    mutating.value = false
  }
}

/** Persist edits to the active customer, then close the form and refresh. */
async function onUpdate(payload: UpdateCustomerInput): Promise<void> {
  if (!editing.value) return
  mutating.value = true
  try {
    await customers.updateCustomer(editing.value.id, payload)
    isFormOpen.value = false
    toast.add({ title: 'Pelanggan diperbarui', color: 'success' })
    await refresh()
  } catch {
    toast.add({ title: 'Gagal memperbarui pelanggan', color: 'error' })
  } finally {
    mutating.value = false
  }
}

/** Soft-delete the active customer, then close the dialog and refresh. */
async function onConfirmDelete(): Promise<void> {
  if (!deleting.value) return
  mutating.value = true
  try {
    await customers.deleteCustomer(deleting.value.id)
    isDeleteOpen.value = false
    toast.add({ title: 'Pelanggan dihapus', color: 'success' })
    await refresh()
  } catch {
    toast.add({ title: 'Gagal menghapus pelanggan', color: 'error' })
  } finally {
    mutating.value = false
  }
}

/** Human-readable label + badge color per customer type. */
const TYPE_META: Record<CustomerTypeValue, { label: string, color: string }> = {
  OUTLET: { label: 'Outlet', color: 'primary' },
  DOCTOR: { label: 'Dokter', color: 'info' },
  COMMUNITY: { label: 'Komunitas', color: 'warning' },
  EVENT: { label: 'Event', color: 'neutral' }
}

const columns: TableColumn<CustomerResponse>[] = [
  {
    accessorKey: 'name',
    header: 'Nama',
    cell: ({ row }) =>
      h(
        NuxtLink,
        {
          to: `/admin/customers/${row.original.id}`,
          class: 'font-medium text-primary hover:underline'
        },
        () => row.original.name
      )
  },
  {
    accessorKey: 'customer_type',
    header: 'Tipe',
    cell: ({ row }) => {
      const meta = TYPE_META[row.original.customer_type]
      return h(UBadge, { color: meta.color, variant: 'subtle', size: 'sm' }, () => meta.label)
    }
  },
  {
    accessorKey: 'city',
    header: 'Kota',
    cell: ({ row }) => row.original.city ?? '—'
  },
  {
    accessorKey: 'erp_customer_code',
    header: 'Kode ERP',
    cell: ({ row }) => row.original.erp_customer_code ?? '—'
  },
  {
    accessorKey: 'is_active',
    header: 'Status',
    cell: ({ row }) =>
      h(
        UBadge,
        {
          color: row.original.is_active ? 'success' : 'neutral',
          variant: 'subtle',
          size: 'sm'
        },
        () => (row.original.is_active ? 'Aktif' : 'Nonaktif')
      )
  },
  {
    id: 'actions',
    header: 'Aksi',
    cell: ({ row }) =>
      h('div', { class: 'flex justify-end gap-1' }, [
        h(UButton, {
          'icon': 'i-lucide-eye',
          'color': 'neutral',
          'variant': 'ghost',
          'size': 'sm',
          'to': `/admin/customers/${row.original.id}`,
          'aria-label': 'Lihat detail'
        }),
        h(UButton, {
          'icon': 'i-lucide-pencil',
          'color': 'neutral',
          'variant': 'ghost',
          'size': 'sm',
          'aria-label': 'Edit',
          'onClick': () => openEdit(row.original)
        }),
        h(UButton, {
          'icon': 'i-lucide-trash-2',
          'color': 'error',
          'variant': 'ghost',
          'size': 'sm',
          'aria-label': 'Hapus',
          'onClick': () => openDelete(row.original)
        })
      ])
  }
]
</script>

<template>
  <div class="flex flex-col gap-6 p-4 sm:p-6">
    <!-- Header + create action -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold text-highlighted">
          Pelanggan
        </h1>
        <p class="mt-0.5 text-sm text-muted">
          Kelola data master Outlet & Dokter.
        </p>
      </div>

      <UButton
        icon="i-lucide-plus"
        color="primary"
        label="Tambah Pelanggan"
        @click="openCreate"
      />
    </div>

    <!-- Filters -->
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <UInput
        v-model="searchInput"
        icon="i-lucide-search"
        placeholder="Cari nama, kode ERP, atau kota"
        class="w-full"
      />
      <USelect
        v-model="typeFilter"
        :items="typeItems"
        value-key="value"
        icon="i-lucide-tag"
        class="w-full"
      />
      <USelect
        v-model="activeFilter"
        :items="activeItems"
        value-key="value"
        icon="i-lucide-toggle-left"
        class="w-full"
      />
      <UInput
        v-model="cityFilter"
        icon="i-lucide-map-pin"
        placeholder="Filter kota"
        class="w-full"
      />
    </div>

    <!-- Error banner -->
    <UAlert
      v-if="error"
      color="error"
      variant="soft"
      icon="i-lucide-circle-alert"
      title="Gagal memuat data pelanggan"
      description="Daftar pelanggan tidak dapat dimuat saat ini. Silakan coba lagi."
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
      empty="Tidak ada pelanggan yang cocok."
      :ui="{ td: 'text-sm text-muted' }"
    />

    <!-- Pagination footer -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <p class="text-xs text-dimmed">
        Menampilkan {{ rows.length }} dari {{ total }} pelanggan.
      </p>
      <UPagination
        v-if="total > PAGE_LIMIT"
        v-model:page="page"
        :items-per-page="PAGE_LIMIT"
        :total="total"
      />
    </div>

    <!-- Create / edit modal -->
    <CustomerFormModal
      v-model:open="isFormOpen"
      :customer="editing"
      :submitting="mutating"
      @create="onCreate"
      @update="onUpdate"
    />

    <!-- Delete confirmation modal -->
    <UModal
      v-model:open="isDeleteOpen"
      title="Hapus Pelanggan"
      :description="deleting
        ? `Hapus '${deleting.name}'? Data akan dinonaktifkan (soft delete).`
        : ''"
      :dismissible="!mutating"
    >
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton
            color="neutral"
            variant="ghost"
            label="Batal"
            :disabled="mutating"
            @click="isDeleteOpen = false"
          />
          <UButton
            color="error"
            label="Hapus"
            :loading="mutating"
            @click="onConfirmDelete"
          />
        </div>
      </template>
    </UModal>
  </div>
</template>
