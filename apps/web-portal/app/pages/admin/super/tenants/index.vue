<script setup lang="ts">
/**
 * `/admin/super/tenants` — cross-tenant company governance, SUPER_ADMIN only.
 *
 * The one screen a super admin uses to provision and govern tenants (`companies`) behind the
 * backend tenant module (see services/api-server/src/modules/tenant/routes.ts), which is itself
 * gated to `SUPER_ADMIN`. It offers:
 *  - a searchable, paginated CRUD table over `GET /tenants`;
 *  - create / edit of identity + branding (tax rate, geofence radius, checkout hour) via
 *    {@link TenantFormModal} (`POST /tenants`, `PATCH /tenants/:id`);
 *  - ERP gateway configuration via {@link TenantERPConfigModal} (`PUT /tenants/:id/erp-config`);
 *  - a kill-switch that deactivates a tenant and invalidates its sessions
 *    (`PATCH /tenants/:id/deactivate`), confirmed in a modal.
 *
 * All data flows through a single {@link useTenantAdmin} instance. The list is a server-driven
 * fetch keyed on the page/search refs. Access is defense-in-depth: the `auth` middleware proves
 * authentication and `super-admin` proves the role, while the backend independently enforces the
 * same boundary. Forced Light Mode is global — no `dark:` variants.
 */
import { computed, ref, watch } from 'vue'
import {
  useTenantAdmin,
  type CreateTenantInput,
  type TenantListResponse,
  type TenantResponse,
  type ListTenantsQuery,
  type UpdateERPConfigInput,
  type UpdateTenantInput
} from '~/composables/useTenantAdmin'
import TenantTable from '~/components/tenant/TenantTable.vue'
import TenantFormModal from '~/components/tenant/TenantFormModal.vue'
import TenantERPConfigModal from '~/components/tenant/TenantERPConfigModal.vue'

definePageMeta({
  layout: 'default',
  middleware: ['auth', 'super-admin']
})

useHead({ title: 'Manajemen Tenant — KF Maction Admin' })

const api = useTenantAdmin()
const toast = useToast()

/** Page size for the paginated list (matches the backend default). */
const PAGE_LIMIT = 20
/** Debounce window (ms) before a keystroke triggers a search refetch. */
const SEARCH_DEBOUNCE_MS = 400

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
  'admin-super-tenants',
  () => api.listTenants(buildQuery()),
  { watch: [page, search] }
)

const rows = computed<TenantResponse[]>(() => data.value?.data ?? [])
const total = computed<number>(() => data.value?.meta.total ?? 0)

// --- Modal state ---
const isFormOpen = ref<boolean>(false)
const editingTenant = ref<TenantResponse | null>(null)
const isErpOpen = ref<boolean>(false)
const erpTenant = ref<TenantResponse | null>(null)
const isDeactivateOpen = ref<boolean>(false)
const deactivatingTenant = ref<TenantResponse | null>(null)
const mutating = ref<boolean>(false)

// --- Open handlers ---
function openCreate(): void {
  editingTenant.value = null
  isFormOpen.value = true
}

function openEdit(row: TenantResponse): void {
  editingTenant.value = rows.value.find(r => r.id === row.id) ?? null
  isFormOpen.value = true
}

function openErp(row: TenantResponse): void {
  erpTenant.value = rows.value.find(r => r.id === row.id) ?? null
  isErpOpen.value = true
}

function openDeactivate(row: TenantResponse): void {
  deactivatingTenant.value = rows.value.find(r => r.id === row.id) ?? null
  isDeactivateOpen.value = true
}

// --- Create ---
async function onCreate(payload: CreateTenantInput): Promise<void> {
  mutating.value = true
  try {
    await api.createTenant(payload)
    isFormOpen.value = false
    toast.add({ title: 'Tenant ditambahkan', color: 'success' })
    await refresh()
  } catch (err) {
    toast.add({
      title: 'Gagal menambahkan tenant',
      description: api.error.value?.code === 'COMPANY_CODE_EXISTS'
        ? 'Kode tenant sudah digunakan.'
        : undefined,
      color: 'error'
    })
    void err
  } finally {
    mutating.value = false
  }
}

// --- Update ---
async function onUpdate(payload: UpdateTenantInput): Promise<void> {
  if (!editingTenant.value) return
  mutating.value = true
  try {
    await api.updateTenant(editingTenant.value.id, payload)
    isFormOpen.value = false
    toast.add({ title: 'Tenant diperbarui', color: 'success' })
    await refresh()
  } catch {
    toast.add({
      title: 'Gagal memperbarui tenant',
      description: api.error.value?.code === 'COMPANY_CODE_EXISTS'
        ? 'Kode tenant sudah digunakan.'
        : undefined,
      color: 'error'
    })
  } finally {
    mutating.value = false
  }
}

// --- ERP config ---
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

// --- Deactivate (kill-switch) ---
async function onConfirmDeactivate(): Promise<void> {
  if (!deactivatingTenant.value) return
  mutating.value = true
  try {
    await api.deactivateTenant(deactivatingTenant.value.id)
    isDeactivateOpen.value = false
    toast.add({ title: 'Tenant dinonaktifkan', color: 'success' })
    await refresh()
  } catch {
    toast.add({ title: 'Gagal menonaktifkan tenant', color: 'error' })
  } finally {
    mutating.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-6 p-4 sm:p-6">
    <!-- Header -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold text-highlighted">
          Manajemen Tenant
        </h1>
        <p class="mt-0.5 text-sm text-muted">
          Provisikan dan kelola perusahaan tenant lintas organisasi (khusus Super Admin).
        </p>
      </div>

      <UButton
        icon="i-lucide-plus"
        color="primary"
        label="Tambah Tenant"
        @click="openCreate"
      />
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

    <TenantTable
      :rows="rows"
      :loading="pending"
      empty-label="Tidak ada tenant yang cocok."
      @edit="openEdit"
      @erp="openErp"
      @deactivate="openDeactivate"
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

    <!-- Create/edit modal -->
    <TenantFormModal
      v-model:open="isFormOpen"
      :record="editingTenant"
      :submitting="mutating"
      @create="onCreate"
      @update="onUpdate"
    />

    <!-- ERP gateway config modal -->
    <TenantERPConfigModal
      v-model:open="isErpOpen"
      :record="erpTenant"
      :submitting="mutating"
      @submit="onSaveErp"
    />

    <!-- Deactivate (kill-switch) confirmation modal -->
    <UModal
      v-model:open="isDeactivateOpen"
      title="Nonaktifkan Tenant"
      :description="deactivatingTenant
        ? `Nonaktifkan '${deactivatingTenant.name}'? Semua sesi aktif tenant akan langsung diputus.`
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
            @click="isDeactivateOpen = false"
          />
          <UButton
            color="error"
            label="Nonaktifkan"
            :loading="mutating"
            @click="onConfirmDeactivate"
          />
        </div>
      </template>
    </UModal>
  </div>
</template>
