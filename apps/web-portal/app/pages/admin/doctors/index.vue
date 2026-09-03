<script setup lang="ts">
/**
 * `/admin/doctors` — doctor master-data management for the web-portal admin roles.
 *
 * Renders a searchable, filterable, paginated table over the tenant's doctors (`master_customer`
 * rows with `customer_type = 'DOCTOR'`) sourced from `GET /doctors` via {@link useDoctors}.
 * Each row links to the doctor 360 / assignment-matrix screen at `/admin/doctors/:id`, where the
 * specialization profile and practice-outlet affiliations are managed. Creating a doctor customer
 * is handled by the shared customer flow (`/admin/customers`, type = Dokter); this screen focuses
 * on the doctor-specific data the customer module does not own.
 *
 * The list is a server-driven fetch keyed on the filter refs (page, search, specialization,
 * active) so every filter change re-queries the backend — no client-side filtering/pagination.
 * Access is gated by the `auth` middleware; the backend independently enforces tenant + role
 * scoping. Forced Light Mode is global — no `dark:` variants.
 */
import { computed, h, ref, resolveComponent, watch } from 'vue'
import type { SelectItem, TableColumn } from '@nuxt/ui'
import {
  useDoctors,
  type DoctorListItem,
  type DoctorListResponse,
  type ListDoctorsQuery
} from '~/composables/useDoctors'

definePageMeta({
  layout: 'default',
  middleware: 'auth'
})

useHead({ title: 'Dokter — KF Maction Admin' })

const doctors = useDoctors()

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
const specializationInput = ref<string>('')
const specialization = ref<string>('')
const activeFilter = ref<'' | 'true' | 'false'>('')

const activeItems: SelectItem[] = [
  { label: 'Semua Status', value: '' },
  { label: 'Aktif', value: 'true' },
  { label: 'Nonaktif', value: 'false' }
]

// --- Debounced text inputs: mirror into the query refs after a quiet window. ---
let searchTimer: ReturnType<typeof setTimeout> | null = null
watch(searchInput, (value) => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    search.value = value.trim()
  }, SEARCH_DEBOUNCE_MS)
})

let specTimer: ReturnType<typeof setTimeout> | null = null
watch(specializationInput, (value) => {
  if (specTimer) clearTimeout(specTimer)
  specTimer = setTimeout(() => {
    specialization.value = value.trim()
  }, SEARCH_DEBOUNCE_MS)
})

// Any filter change (except page) resets to the first page so results stay coherent.
watch([search, specialization, activeFilter], () => {
  page.value = 1
})

/** Build the backend query from the active filter refs, dropping empty selections. */
function buildQuery(): ListDoctorsQuery {
  const query: ListDoctorsQuery = { page: page.value, limit: PAGE_LIMIT }
  if (search.value) query.search = search.value
  if (specialization.value) query.specialization = specialization.value
  if (activeFilter.value) query.is_active = activeFilter.value === 'true'
  return query
}

// SSR-friendly fetch keyed on all filter refs — refetches on any change.
const { data, pending, error, refresh } = await useAsyncData<DoctorListResponse>(
  'admin-doctors',
  () => doctors.listDoctors(buildQuery()),
  { watch: [page, search, specialization, activeFilter] }
)

const rows = computed<DoctorListItem[]>(() => data.value?.data ?? [])
const total = computed<number>(() => data.value?.meta.total ?? 0)

const columns: TableColumn<DoctorListItem>[] = [
  {
    accessorKey: 'name',
    header: 'Nama Dokter',
    cell: ({ row }) =>
      h(
        NuxtLink,
        {
          to: `/admin/doctors/${row.original.id}`,
          class: 'font-medium text-primary hover:underline'
        },
        () => row.original.name
      )
  },
  {
    id: 'specialization',
    header: 'Spesialisasi',
    cell: ({ row }) => row.original.doctor_profile?.specialization ?? '—'
  },
  {
    id: 'sip_str',
    header: 'No. SIP/STR',
    cell: ({ row }) => row.original.doctor_profile?.sip_str_number ?? '—'
  },
  {
    accessorKey: 'city',
    header: 'Kota',
    cell: ({ row }) => row.original.city ?? '—'
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
      h('div', { class: 'flex justify-end' }, [
        h(UButton, {
          'icon': 'i-lucide-arrow-right',
          'color': 'neutral',
          'variant': 'ghost',
          'size': 'sm',
          'to': `/admin/doctors/${row.original.id}`,
          'aria-label': 'Kelola dokter'
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
          Dokter
        </h1>
        <p class="mt-0.5 text-sm text-muted">
          Kelola profil dokter & matriks afiliasi outlet praktik.
        </p>
      </div>

      <UButton
        to="/admin/customers"
        icon="i-lucide-plus"
        color="primary"
        variant="outline"
        label="Tambah via Pelanggan"
      />
    </div>

    <!-- Filters -->
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <UInput
        v-model="searchInput"
        icon="i-lucide-search"
        placeholder="Cari nama atau No. SIP/STR"
        class="w-full"
      />
      <UInput
        v-model="specializationInput"
        icon="i-lucide-stethoscope"
        placeholder="Filter spesialisasi"
        class="w-full"
      />
      <USelect
        v-model="activeFilter"
        :items="activeItems"
        value-key="value"
        icon="i-lucide-toggle-left"
        class="w-full"
      />
    </div>

    <!-- Error banner -->
    <UAlert
      v-if="error"
      color="error"
      variant="soft"
      icon="i-lucide-circle-alert"
      title="Gagal memuat data dokter"
      description="Daftar dokter tidak dapat dimuat saat ini. Silakan coba lagi."
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
      empty="Tidak ada dokter yang cocok."
      :ui="{ td: 'text-sm text-muted' }"
    />

    <!-- Pagination footer -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <p class="text-xs text-dimmed">
        Menampilkan {{ rows.length }} dari {{ total }} dokter.
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
