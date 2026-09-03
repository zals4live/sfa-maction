<script setup lang="ts">
/**
 * `/admin/super/erp-config` — ERP gateway governance across tenants, SUPER_ADMIN only.
 *
 * The dedicated screen a super admin uses to inspect and configure each tenant's ERP gateway
 * integration behind the backend tenant module (see services/api-server/src/modules/tenant/
 * routes.ts), which is itself gated to `SUPER_ADMIN`. Unlike the broader tenant management page,
 * this view is ERP-focused: per tenant it surfaces the ERP system type, endpoint URL, company
 * code, and a configured/not-configured status, and offers a single "Konfigurasi ERP" action
 * that persists via `PUT /tenants/:id/erp-config` through {@link useTenantAdmin}.
 *
 * The list is a searchable, server-driven fetch keyed on the page/search refs. Access is
 * defense-in-depth: the `auth` middleware proves authentication and `super-admin` proves the
 * role, while the backend independently enforces the same boundary. Forced Light Mode is
 * global — no `dark:` variants.
 */
import { computed, h, ref, resolveComponent, watch } from 'vue'
import type { TableColumn } from '@nuxt/ui'
import {
  useTenantAdmin,
  type ListTenantsQuery,
  type TenantListResponse,
  type TenantResponse,
  type UpdateERPConfigInput
} from '~/composables/useTenantAdmin'
import TenantERPConfigModal from '~/components/tenant/TenantERPConfigModal.vue'

definePageMeta({
  layout: 'default',
  middleware: ['auth', 'super-admin']
})

useHead({ title: 'Konfigurasi ERP — KF Maction Admin' })

const api = useTenantAdmin()
const toast = useToast()

/** Page size for the paginated list (matches the backend default). */
const PAGE_LIMIT = 20
/** Debounce window (ms) before a keystroke triggers a search refetch. */
const SEARCH_DEBOUNCE_MS = 400

const UBadge = resolveComponent('UBadge')
const UButton = resolveComponent('UButton')

// --- List state ---
const page = ref<number>(1)
const searchInput = ref<string>('')
const search = ref<string>('')

let searchTimer: ReturnType<typeof setTimeout> | null = null
watch(searchInput, (value) => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    search.value = value.trim()
  }, SEARCH_DEBOUNCE_MS)
})
watch(search, () => {
  page.value = 1
})

/** Build the list query from the page/search refs, dropping an empty search. */
function buildQuery(): ListTenantsQuery {
  const query: ListTenantsQuery = { page: page.value, limit: PAGE_LIMIT }
  if (search.value) query.search = search.value
  return query
}

const { data, pending, error, refresh } = await useAsyncData<TenantListResponse>(
  'admin-super-erp-config',
  () => api.listTenants(buildQuery()),
  { watch: [page, search] }
)

const rows = computed<TenantResponse[]>(() => data.value?.data ?? [])
const total = computed<number>(() => data.value?.meta.total ?? 0)

// --- Modal state ---
const isErpOpen = ref<boolean>(false)
const erpTenant = ref<TenantResponse | null>(null)
const mutating = ref<boolean>(false)

/** Open the ERP config modal for a tenant row. */
function openErp(row: TenantResponse): void {
  erpTenant.value = rows.value.find(r => r.id === row.id) ?? null
  isErpOpen.value = true
}

/** Persist the ERP gateway config, then toast + refresh the list. */
async function onSaveErp(payload: UpdateERPConfigInput): Promise<void> {
  if (!erpTenant.value) return
  mutating.value = true
  try {
    await api.updateERPConfig(erpTenant.value.id, payload)
    isErpOpen.value = false
    toast.add({ title: 'Konfigurasi ERP disimpan', color: 'success' })
    await refresh()
  } catch {
    toast.add({ title: 'Gagal menyimpan konfigurasi ERP', color: 'error' })
  } finally {
    mutating.value = false
  }
}

/** ERP-focused table columns: system type, endpoint, company code, status, action. */
const columns: TableColumn<TenantResponse>[] = [
  {
    accessorKey: 'name',
    header: 'Tenant',
    cell: ({ row }) =>
      h('div', { class: 'flex flex-col' }, [
        h('span', { class: 'font-medium text-highlighted' }, row.original.name),
        h('span', { class: 'text-xs text-dimmed' }, row.original.code)
      ])
  },
  {
    accessorKey: 'erp_system_type',
    header: 'Tipe Sistem',
    cell: ({ row }) =>
      row.original.erp_system_type
        ? h(
            UBadge,
            { color: 'primary', variant: 'subtle', size: 'sm' },
            () => row.original.erp_system_type
          )
        : h('span', { class: 'text-dimmed' }, '—')
  },
  {
    accessorKey: 'erp_endpoint_url',
    header: 'Endpoint URL',
    cell: ({ row }) =>
      row.original.erp_endpoint_url
        ? h('span', { class: 'font-mono text-xs' }, row.original.erp_endpoint_url)
        : h('span', { class: 'text-dimmed' }, '—')
  },
  {
    accessorKey: 'erp_company_code',
    header: 'Kode Perusahaan',
    cell: ({ row }) => row.original.erp_company_code ?? '—'
  },
  {
    id: 'erp_status',
    header: 'Status',
    cell: ({ row }) => {
      const configured = Boolean(row.original.erp_system_type && row.original.erp_endpoint_url)
      return h(
        UBadge,
        {
          color: configured ? 'success' : 'neutral',
          variant: 'subtle',
          size: 'sm'
        },
        () => (configured ? 'Terkonfigurasi' : 'Belum diatur')
      )
    }
  },
  {
    id: 'actions',
    header: 'Aksi',
    cell: ({ row }) =>
      h('div', { class: 'flex justify-end' }, [
        h(UButton, {
          'icon': 'i-lucide-plug',
          'color': 'primary',
          'variant': 'ghost',
          'size': 'sm',
          'label': 'Konfigurasi ERP',
          'aria-label': 'Konfigurasi ERP',
          'onClick': () => openErp(row.original)
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
          Konfigurasi ERP
        </h1>
        <p class="mt-0.5 text-sm text-muted">
          Kelola integrasi gateway ERP untuk setiap tenant (khusus Super Admin).
        </p>
      </div>
    </div>

    <!-- Search -->
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <UInput
        v-model="searchInput"
        icon="i-lucide-search"
        placeholder="Cari kode atau nama tenant"
        class="w-full"
      />
    </div>

    <UAlert
      v-if="error"
      color="error"
      variant="soft"
      icon="i-lucide-circle-alert"
      title="Gagal memuat data tenant"
      description="Daftar tenant tidak dapat dimuat saat ini. Silakan coba lagi."
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

    <UTable
      :data="rows"
      :columns="columns"
      :loading="pending"
      loading-color="primary"
      empty="Tidak ada tenant yang cocok."
      :ui="{ td: 'text-sm text-muted' }"
    />

    <div class="flex flex-wrap items-center justify-between gap-3">
      <p class="text-xs text-dimmed">
        Menampilkan {{ rows.length }} dari {{ total }} tenant.
      </p>
      <UPagination
        v-if="total > PAGE_LIMIT"
        v-model:page="page"
        :items-per-page="PAGE_LIMIT"
        :total="total"
      />
    </div>

    <!-- ERP gateway config modal -->
    <TenantERPConfigModal
      v-model:open="isErpOpen"
      :record="erpTenant"
      :submitting="mutating"
      @submit="onSaveErp"
    />
  </div>
</template>
