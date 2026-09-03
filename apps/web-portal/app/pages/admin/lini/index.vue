<script setup lang="ts">
/**
 * `/admin/lini` — business-line (Lini) & product-variant (Varian) master data, plus the
 * user→lini assignment interface, for the web-portal admin roles.
 *
 * Three concerns share one screen behind a tab switcher:
 *  - "Lini": a searchable, filterable, paginated CRUD table over `master_lini`
 *    (`GET/POST/PATCH/DELETE /lini`).
 *  - "Varian": the same CRUD surface over `master_varian` (`GET/POST/PATCH/DELETE /varian`).
 *  - "Penugasan Pengguna": the M:N assignment panel that grants/revokes lini scope to a field
 *    user (`GET/POST/DELETE /users/:id/lini`).
 *
 * All data flows through a single tenant-scoped {@link useLini} instance. Create/edit for both
 * master entities reuse {@link MasterFormModal}; delete is a soft-delete confirmed in a modal.
 * The lists are server-driven fetches keyed on their filter refs. Access is gated by the `auth`
 * middleware (ADMIN_PUSAT / SUPER_ADMIN on the backend); Forced Light Mode is global — no
 * `dark:` variants.
 */
import { computed, ref, watch } from 'vue'
import type { SelectItem, TabsItem } from '@nuxt/ui'
import {
  useLini,
  type CreateLiniInput,
  type CreateVarianInput,
  type LiniListResponse,
  type LiniResponse,
  type ListMasterQuery,
  type UpdateLiniInput,
  type UpdateVarianInput,
  type VarianListResponse,
  type VarianResponse
} from '~/composables/useLini'
import MasterDataTable from '~/components/lini/MasterDataTable.vue'
import MasterFormModal from '~/components/lini/MasterFormModal.vue'
import UserLiniAssignmentPanel from '~/components/lini/UserLiniAssignmentPanel.vue'

definePageMeta({
  layout: 'default',
  middleware: 'auth'
})

useHead({ title: 'Lini & Varian — KF Maction Admin' })

const api = useLini()
const toast = useToast()

/** Page size for the paginated lists (matches the backend default). */
const PAGE_LIMIT = 20
/** Debounce window (ms) before a keystroke triggers a search refetch. */
const SEARCH_DEBOUNCE_MS = 400
/** Max active lini loaded into the assignment catalog (single-page, not paginated). */
const CATALOG_LIMIT = 100

/** Emitted create/update payload shape shared by both master modals. */
interface MasterFormPayload {
  code: string
  name: string
  description: string | null
  is_active: boolean
}

/** The minimal row shape emitted by {@link MasterDataTable}'s edit/delete events. */
interface MasterRowRef {
  id: string
}

// --- Tabs ---
const activeTab = ref<string>('lini')
const tabItems: TabsItem[] = [
  { label: 'Lini', value: 'lini', icon: 'i-lucide-layers' },
  { label: 'Varian', value: 'varian', icon: 'i-lucide-boxes' },
  { label: 'Penugasan Pengguna', value: 'assignments', icon: 'i-lucide-user-cog' }
]

const activeItems: SelectItem[] = [
  { label: 'Semua Status', value: '' },
  { label: 'Aktif', value: 'true' },
  { label: 'Nonaktif', value: 'false' }
]

/** Build a paginated master query from page/search/active refs, dropping empty selections. */
function buildQuery(page: number, search: string, active: '' | 'true' | 'false'): ListMasterQuery {
  const query: ListMasterQuery = { page, limit: PAGE_LIMIT }
  if (search) query.search = search
  if (active) query.is_active = active === 'true'
  return query
}

// =====================================================================================
// Lini list state
// =====================================================================================
const liniPage = ref<number>(1)
const liniSearchInput = ref<string>('')
const liniSearch = ref<string>('')
const liniActiveFilter = ref<'' | 'true' | 'false'>('')

let liniSearchTimer: ReturnType<typeof setTimeout> | null = null
watch(liniSearchInput, (value) => {
  if (liniSearchTimer) clearTimeout(liniSearchTimer)
  liniSearchTimer = setTimeout(() => {
    liniSearch.value = value.trim()
  }, SEARCH_DEBOUNCE_MS)
})
watch([liniSearch, liniActiveFilter], () => {
  liniPage.value = 1
})

const {
  data: liniData,
  pending: liniPending,
  error: liniError,
  refresh: refreshLini
} = await useAsyncData<LiniListResponse>(
  'admin-lini',
  () => api.listLini(buildQuery(liniPage.value, liniSearch.value, liniActiveFilter.value)),
  { watch: [liniPage, liniSearch, liniActiveFilter] }
)

const liniRows = computed<LiniResponse[]>(() => liniData.value?.data ?? [])
const liniTotal = computed<number>(() => liniData.value?.meta.total ?? 0)

// =====================================================================================
// Varian list state
// =====================================================================================
const varianPage = ref<number>(1)
const varianSearchInput = ref<string>('')
const varianSearch = ref<string>('')
const varianActiveFilter = ref<'' | 'true' | 'false'>('')

let varianSearchTimer: ReturnType<typeof setTimeout> | null = null
watch(varianSearchInput, (value) => {
  if (varianSearchTimer) clearTimeout(varianSearchTimer)
  varianSearchTimer = setTimeout(() => {
    varianSearch.value = value.trim()
  }, SEARCH_DEBOUNCE_MS)
})
watch([varianSearch, varianActiveFilter], () => {
  varianPage.value = 1
})

const {
  data: varianData,
  pending: varianPending,
  error: varianError,
  refresh: refreshVarian
} = await useAsyncData<VarianListResponse>(
  'admin-varian',
  () => api.listVarian(buildQuery(varianPage.value, varianSearch.value, varianActiveFilter.value)),
  { watch: [varianPage, varianSearch, varianActiveFilter] }
)

const varianRows = computed<VarianResponse[]>(() => varianData.value?.data ?? [])
const varianTotal = computed<number>(() => varianData.value?.meta.total ?? 0)

// =====================================================================================
// Assignment catalog — active lini available to assign (loaded lazily on tab switch)
// =====================================================================================
const liniCatalog = ref<LiniResponse[]>([])
const catalogLoaded = ref<boolean>(false)
const catalogLoading = ref<boolean>(false)

/** Fetch the active-lini catalog once, for the assignment panel's add-picker. */
async function ensureCatalogLoaded(): Promise<void> {
  if (catalogLoaded.value || catalogLoading.value) return
  catalogLoading.value = true
  try {
    const result = await api.listLini({ is_active: true, limit: CATALOG_LIMIT })
    liniCatalog.value = result.data
    catalogLoaded.value = true
  } catch {
    toast.add({ title: 'Gagal memuat katalog lini', color: 'error' })
  } finally {
    catalogLoading.value = false
  }
}

watch(activeTab, (tab) => {
  if (tab === 'assignments') void ensureCatalogLoaded()
})

// =====================================================================================
// Modal state (shared draft target discriminated by the active tab)
// =====================================================================================
const isFormOpen = ref<boolean>(false)
const editingLini = ref<LiniResponse | null>(null)
const editingVarian = ref<VarianResponse | null>(null)
const isDeleteOpen = ref<boolean>(false)
const deletingLini = ref<LiniResponse | null>(null)
const deletingVarian = ref<VarianResponse | null>(null)
const mutating = ref<boolean>(false)

/** Human label for the entity behind the currently active master tab. */
const entityLabel = computed<string>(() => (activeTab.value === 'varian' ? 'Varian' : 'Lini'))

/** The record currently open for edit (null in create mode), for the active master tab. */
const editingRecord = computed<LiniResponse | VarianResponse | null>(() =>
  activeTab.value === 'varian' ? editingVarian.value : editingLini.value
)

/** The record queued for delete, for the active master tab. */
const deletingRecord = computed<LiniResponse | VarianResponse | null>(() =>
  activeTab.value === 'varian' ? deletingVarian.value : deletingLini.value
)

// --- Open handlers ---
function openCreate(): void {
  editingLini.value = null
  editingVarian.value = null
  isFormOpen.value = true
}

function openEditLini(row: MasterRowRef): void {
  editingLini.value = liniRows.value.find(r => r.id === row.id) ?? null
  isFormOpen.value = true
}

function openEditVarian(row: MasterRowRef): void {
  editingVarian.value = varianRows.value.find(r => r.id === row.id) ?? null
  isFormOpen.value = true
}

function openDeleteLini(row: MasterRowRef): void {
  deletingLini.value = liniRows.value.find(r => r.id === row.id) ?? null
  isDeleteOpen.value = true
}

function openDeleteVarian(row: MasterRowRef): void {
  deletingVarian.value = varianRows.value.find(r => r.id === row.id) ?? null
  isDeleteOpen.value = true
}

// --- Create ---
async function onCreate(payload: MasterFormPayload): Promise<void> {
  mutating.value = true
  try {
    if (activeTab.value === 'varian') {
      await api.createVarian(payload as CreateVarianInput)
      await refreshVarian()
    } else {
      await api.createLini(payload as CreateLiniInput)
      catalogLoaded.value = false
      await refreshLini()
    }
    isFormOpen.value = false
    toast.add({ title: `${entityLabel.value} ditambahkan`, color: 'success' })
  } catch {
    toast.add({ title: `Gagal menambahkan ${entityLabel.value.toLowerCase()}`, color: 'error' })
  } finally {
    mutating.value = false
  }
}

// --- Update ---
async function onUpdate(payload: MasterFormPayload): Promise<void> {
  mutating.value = true
  try {
    if (activeTab.value === 'varian') {
      if (!editingVarian.value) return
      await api.updateVarian(editingVarian.value.id, payload as UpdateVarianInput)
      await refreshVarian()
    } else {
      if (!editingLini.value) return
      await api.updateLini(editingLini.value.id, payload as UpdateLiniInput)
      catalogLoaded.value = false
      await refreshLini()
    }
    isFormOpen.value = false
    toast.add({ title: `${entityLabel.value} diperbarui`, color: 'success' })
  } catch {
    toast.add({ title: `Gagal memperbarui ${entityLabel.value.toLowerCase()}`, color: 'error' })
  } finally {
    mutating.value = false
  }
}

// --- Delete (soft) ---
async function onConfirmDelete(): Promise<void> {
  mutating.value = true
  try {
    if (activeTab.value === 'varian') {
      if (!deletingVarian.value) return
      await api.deleteVarian(deletingVarian.value.id)
      await refreshVarian()
    } else {
      if (!deletingLini.value) return
      await api.deleteLini(deletingLini.value.id)
      catalogLoaded.value = false
      await refreshLini()
    }
    isDeleteOpen.value = false
    toast.add({ title: `${entityLabel.value} dihapus`, color: 'success' })
  } catch {
    toast.add({ title: `Gagal menghapus ${entityLabel.value.toLowerCase()}`, color: 'error' })
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
          Lini &amp; Varian
        </h1>
        <p class="mt-0.5 text-sm text-muted">
          Kelola lini bisnis, varian produk, dan penugasan lini pengguna.
        </p>
      </div>

      <UButton
        v-if="activeTab !== 'assignments'"
        icon="i-lucide-plus"
        color="primary"
        :label="`Tambah ${entityLabel}`"
        @click="openCreate"
      />
    </div>

    <UTabs
      v-model="activeTab"
      :items="tabItems"
      :content="false"
    />

    <!-- ============================= Lini tab ============================= -->
    <div
      v-if="activeTab === 'lini'"
      class="flex flex-col gap-4"
    >
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <UInput
          v-model="liniSearchInput"
          icon="i-lucide-search"
          placeholder="Cari kode atau nama lini"
          class="w-full"
        />
        <USelect
          v-model="liniActiveFilter"
          :items="activeItems"
          value-key="value"
          icon="i-lucide-toggle-left"
          class="w-full"
        />
      </div>

      <UAlert
        v-if="liniError"
        color="error"
        variant="soft"
        icon="i-lucide-circle-alert"
        title="Gagal memuat data lini"
        description="Daftar lini tidak dapat dimuat saat ini. Silakan coba lagi."
      >
        <template #actions>
          <UButton
            color="error"
            variant="outline"
            size="xs"
            label="Coba Lagi"
            @click="refreshLini()"
          />
        </template>
      </UAlert>

      <MasterDataTable
        :rows="liniRows"
        :loading="liniPending"
        empty-label="Tidak ada lini yang cocok."
        @edit="openEditLini"
        @delete="openDeleteLini"
      />

      <div class="flex flex-wrap items-center justify-between gap-3">
        <p class="text-xs text-dimmed">
          Menampilkan {{ liniRows.length }} dari {{ liniTotal }} lini.
        </p>
        <UPagination
          v-if="liniTotal > PAGE_LIMIT"
          v-model:page="liniPage"
          :items-per-page="PAGE_LIMIT"
          :total="liniTotal"
        />
      </div>
    </div>

    <!-- ============================ Varian tab =========================== -->
    <div
      v-else-if="activeTab === 'varian'"
      class="flex flex-col gap-4"
    >
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <UInput
          v-model="varianSearchInput"
          icon="i-lucide-search"
          placeholder="Cari kode atau nama varian"
          class="w-full"
        />
        <USelect
          v-model="varianActiveFilter"
          :items="activeItems"
          value-key="value"
          icon="i-lucide-toggle-left"
          class="w-full"
        />
      </div>

      <UAlert
        v-if="varianError"
        color="error"
        variant="soft"
        icon="i-lucide-circle-alert"
        title="Gagal memuat data varian"
        description="Daftar varian tidak dapat dimuat saat ini. Silakan coba lagi."
      >
        <template #actions>
          <UButton
            color="error"
            variant="outline"
            size="xs"
            label="Coba Lagi"
            @click="refreshVarian()"
          />
        </template>
      </UAlert>

      <MasterDataTable
        :rows="varianRows"
        :loading="varianPending"
        empty-label="Tidak ada varian yang cocok."
        @edit="openEditVarian"
        @delete="openDeleteVarian"
      />

      <div class="flex flex-wrap items-center justify-between gap-3">
        <p class="text-xs text-dimmed">
          Menampilkan {{ varianRows.length }} dari {{ varianTotal }} varian.
        </p>
        <UPagination
          v-if="varianTotal > PAGE_LIMIT"
          v-model:page="varianPage"
          :items-per-page="PAGE_LIMIT"
          :total="varianTotal"
        />
      </div>
    </div>

    <!-- ========================= Assignments tab ========================= -->
    <UserLiniAssignmentPanel
      v-else
      :api="api"
      :lini-catalog="liniCatalog"
    />

    <!-- Shared create/edit modal (lini or varian per active tab) -->
    <MasterFormModal
      v-model:open="isFormOpen"
      :record="editingRecord"
      :entity-label="entityLabel"
      :submitting="mutating"
      @create="onCreate"
      @update="onUpdate"
    />

    <!-- Delete confirmation modal -->
    <UModal
      v-model:open="isDeleteOpen"
      :title="`Hapus ${entityLabel}`"
      :description="deletingRecord
        ? `Hapus '${deletingRecord.name}'? Data akan dinonaktifkan (soft delete).`
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
