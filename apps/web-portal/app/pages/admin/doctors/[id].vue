<script setup lang="ts">
/**
 * `/admin/doctors/:id` — doctor management: profile + outlet assignment matrix.
 *
 * Aggregates everything an admin manages for one doctor on a single screen:
 *  - Identity header (name, specialization, active status).
 *  - Specialization profile (SIP/STR, specialization, sub-specialization, notes) sourced from
 *    `doctor_profiles`, editable via {@link DoctorProfileModal} (`PATCH /doctors/:id/profile`).
 *  - The doctor-outlet assignment matrix (`doctor_outlet_assignments`): the M:N affiliations
 *    to practice outlets, with add/edit/delete flowing through {@link AssignmentFormModal} and
 *    {@link AssignmentMatrix} (`POST/PATCH/DELETE /doctors/:id/assignments`).
 *  - A Leaflet map pinpointing the doctor's stored coordinates.
 *
 * Data flows through the tenant-scoped {@link useDoctors} composable; the outlet picker for new
 * affiliations is populated from {@link useCustomers} (customer_type = OUTLET). The map is
 * wrapped in <ClientOnly> to avoid Leaflet SSR issues. Access is gated by the `auth`
 * middleware; the backend independently enforces tenant + role scoping. Forced Light Mode is
 * global — no `dark:` variants.
 */
import { computed, ref } from 'vue'
import type { CustomerResponse } from '~/composables/useCustomers'
import {
  useDoctors,
  type CreateAssignmentInput,
  type DoctorAssignmentResponse,
  type DoctorDetailResponse,
  type DoctorProfileInput,
  type UpdateAssignmentInput
} from '~/composables/useDoctors'
import { useCustomers } from '~/composables/useCustomers'
import DoctorProfileModal from '~/components/doctor/DoctorProfileModal.vue'
import AssignmentMatrix from '~/components/doctor/AssignmentMatrix.vue'
import AssignmentFormModal from '~/components/doctor/AssignmentFormModal.vue'
import CustomerPinpointMap from '~/components/customer/CustomerPinpointMap.vue'

definePageMeta({
  layout: 'default',
  middleware: 'auth'
})

const route = useRoute()
const doctors = useDoctors()
const customers = useCustomers()
const toast = useToast()

/** Max outlets loaded into the picker (single-page picker, not paginated). */
const OUTLET_PICKER_LIMIT = 100

/** Route param — the doctor's customer id. */
const doctorId = computed<string>(() => String(route.params.id))

// Fetch the doctor detail (profile + assignments), SSR-friendly.
const {
  data: detailData,
  pending: detailPending,
  error: detailError,
  refresh
} = await useAsyncData<{ data: DoctorDetailResponse }>(
  () => `doctor-detail-${doctorId.value}`,
  () => doctors.getDoctor(doctorId.value),
  { watch: [doctorId] }
)

const doctor = computed<DoctorDetailResponse | null>(() => detailData.value?.data ?? null)
const assignments = computed<DoctorAssignmentResponse[]>(() => doctor.value?.assignments ?? [])

useHead(() => ({
  title: doctor.value
    ? `${doctor.value.name} — KF Maction Admin`
    : 'Detail Dokter — KF Maction Admin'
}))

// --- Outlet picker options (loaded lazily on first assignment-add) ---
/** A single `{ label, value }` picker option; kept local to avoid deep SelectItem inference. */
interface OutletOption {
  label: string
  value: string
}
const outletOptions = ref<OutletOption[]>([])
const outletsLoading = ref<boolean>(false)
const outletsLoaded = ref<boolean>(false)

/** Fetch active outlets once and map them into `{ label, value }` picker items. */
async function ensureOutletsLoaded(): Promise<void> {
  if (outletsLoaded.value || outletsLoading.value) return
  outletsLoading.value = true
  try {
    const result = await customers.listCustomers({
      customer_type: 'OUTLET',
      is_active: true,
      limit: OUTLET_PICKER_LIMIT
    })
    outletOptions.value = result.data.map((c: CustomerResponse): OutletOption => ({
      label: c.city ? `${c.name} — ${c.city}` : c.name,
      value: c.id
    }))
    outletsLoaded.value = true
  } catch {
    toast.add({ title: 'Gagal memuat daftar outlet', color: 'error' })
  } finally {
    outletsLoading.value = false
  }
}

// --- Profile modal state ---
const isProfileOpen = ref<boolean>(false)
const mutatingProfile = ref<boolean>(false)

function openProfileEdit(): void {
  isProfileOpen.value = true
}

/** Persist the doctor's profile upsert, then close and refresh. */
async function onProfileSubmit(payload: DoctorProfileInput): Promise<void> {
  mutatingProfile.value = true
  try {
    await doctors.updateProfile(doctorId.value, payload)
    isProfileOpen.value = false
    toast.add({ title: 'Profil dokter diperbarui', color: 'success' })
    await refresh()
  } catch {
    toast.add({ title: 'Gagal memperbarui profil', color: 'error' })
  } finally {
    mutatingProfile.value = false
  }
}

// --- Assignment modal state ---
const isAssignmentOpen = ref<boolean>(false)
const editingAssignment = ref<DoctorAssignmentResponse | null>(null)
const mutatingAssignment = ref<boolean>(false)
const isDeleteOpen = ref<boolean>(false)
const deletingAssignment = ref<DoctorAssignmentResponse | null>(null)

/** Open the assignment form in create mode (loads outlets on demand). */
async function openAssignmentCreate(): Promise<void> {
  editingAssignment.value = null
  isAssignmentOpen.value = true
  await ensureOutletsLoaded()
}

/** Open the assignment form in edit mode for a given row. */
function openAssignmentEdit(assignment: DoctorAssignmentResponse): void {
  editingAssignment.value = assignment
  isAssignmentOpen.value = true
}

/** Open the delete confirmation for a given affiliation. */
function openAssignmentDelete(assignment: DoctorAssignmentResponse): void {
  deletingAssignment.value = assignment
  isDeleteOpen.value = true
}

/** Persist a new affiliation, then close and refresh. */
async function onAssignmentCreate(payload: CreateAssignmentInput): Promise<void> {
  mutatingAssignment.value = true
  try {
    await doctors.createAssignment(doctorId.value, payload)
    isAssignmentOpen.value = false
    toast.add({ title: 'Afiliasi ditambahkan', color: 'success' })
    await refresh()
  } catch {
    toast.add({ title: 'Gagal menambahkan afiliasi', color: 'error' })
  } finally {
    mutatingAssignment.value = false
  }
}

/** Persist edits to the active affiliation, then close and refresh. */
async function onAssignmentUpdate(payload: UpdateAssignmentInput): Promise<void> {
  if (!editingAssignment.value) return
  mutatingAssignment.value = true
  try {
    await doctors.updateAssignment(doctorId.value, editingAssignment.value.id, payload)
    isAssignmentOpen.value = false
    toast.add({ title: 'Afiliasi diperbarui', color: 'success' })
    await refresh()
  } catch {
    toast.add({ title: 'Gagal memperbarui afiliasi', color: 'error' })
  } finally {
    mutatingAssignment.value = false
  }
}

/** Soft-delete the active affiliation, then close and refresh. */
async function onConfirmDelete(): Promise<void> {
  if (!deletingAssignment.value) return
  mutatingAssignment.value = true
  try {
    await doctors.deleteAssignment(doctorId.value, deletingAssignment.value.id)
    isDeleteOpen.value = false
    toast.add({ title: 'Afiliasi dihapus', color: 'success' })
    await refresh()
  } catch {
    toast.add({ title: 'Gagal menghapus afiliasi', color: 'error' })
  } finally {
    mutatingAssignment.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-6 p-4 sm:p-6">
    <!-- Back link -->
    <div>
      <UButton
        to="/admin/doctors"
        icon="i-lucide-arrow-left"
        color="neutral"
        variant="ghost"
        size="sm"
        label="Kembali ke Dokter"
      />
    </div>

    <!-- Error banner -->
    <UAlert
      v-if="detailError"
      color="error"
      variant="soft"
      icon="i-lucide-circle-alert"
      title="Gagal memuat detail dokter"
      description="Detail dokter tidak dapat dimuat saat ini. Silakan coba lagi."
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

    <!-- Loading skeleton -->
    <div
      v-else-if="detailPending && !doctor"
      class="flex items-center gap-2 text-muted"
    >
      <UIcon
        name="i-lucide-loader-circle"
        class="size-5 animate-spin"
      />
      <span class="text-sm">Memuat detail dokter…</span>
    </div>

    <template v-else-if="doctor">
      <!-- Identity header -->
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="flex flex-col gap-1">
          <div class="flex items-center gap-2">
            <h1 class="text-xl font-semibold text-highlighted">
              {{ doctor.name }}
            </h1>
            <UBadge
              color="info"
              variant="subtle"
              size="sm"
              label="Dokter"
            />
            <UBadge
              :color="doctor.is_active ? 'success' : 'neutral'"
              variant="subtle"
              size="sm"
              :label="doctor.is_active ? 'Aktif' : 'Nonaktif'"
            />
          </div>
          <p class="text-sm text-muted">
            {{ doctor.doctor_profile?.specialization ?? 'Spesialisasi belum diisi' }}
          </p>
        </div>
      </div>

      <div class="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <!-- Profile + assignment matrix -->
        <div class="flex flex-col gap-6 lg:col-span-2">
          <!-- Profile card -->
          <UCard>
            <template #header>
              <div class="flex items-center justify-between gap-3">
                <h2 class="text-base font-semibold text-highlighted">
                  Profil Dokter
                </h2>
                <UButton
                  icon="i-lucide-pencil"
                  color="neutral"
                  variant="ghost"
                  size="sm"
                  label="Edit"
                  @click="openProfileEdit"
                />
              </div>
            </template>

            <dl class="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <dt class="text-xs text-muted">
                  Spesialisasi
                </dt>
                <dd class="text-sm text-highlighted">
                  {{ doctor.doctor_profile?.specialization ?? '—' }}
                </dd>
              </div>
              <div>
                <dt class="text-xs text-muted">
                  Sub-spesialisasi
                </dt>
                <dd class="text-sm text-highlighted">
                  {{ doctor.doctor_profile?.sub_specialization ?? '—' }}
                </dd>
              </div>
              <div>
                <dt class="text-xs text-muted">
                  No. SIP/STR
                </dt>
                <dd class="text-sm text-highlighted">
                  {{ doctor.doctor_profile?.sip_str_number ?? '—' }}
                </dd>
              </div>
              <div>
                <dt class="text-xs text-muted">
                  Kota
                </dt>
                <dd class="text-sm text-highlighted">
                  {{ doctor.city ?? '—' }}
                </dd>
              </div>
              <div class="sm:col-span-2">
                <dt class="text-xs text-muted">
                  Catatan
                </dt>
                <dd class="text-sm text-highlighted">
                  {{ doctor.doctor_profile?.notes ?? '—' }}
                </dd>
              </div>
            </dl>
          </UCard>

          <!-- Assignment matrix card -->
          <UCard>
            <template #header>
              <div class="flex items-center justify-between gap-3">
                <div>
                  <h2 class="text-base font-semibold text-highlighted">
                    Matriks Afiliasi Outlet
                  </h2>
                  <p class="mt-0.5 text-xs text-muted">
                    Outlet praktik tempat dokter ini beraktivitas.
                  </p>
                </div>
                <UButton
                  icon="i-lucide-plus"
                  color="primary"
                  size="sm"
                  label="Tambah Afiliasi"
                  @click="openAssignmentCreate"
                />
              </div>
            </template>

            <AssignmentMatrix
              :assignments="assignments"
              :loading="detailPending"
              @edit="openAssignmentEdit"
              @delete="openAssignmentDelete"
            />
          </UCard>
        </div>

        <!-- Map pinpoint -->
        <UCard :ui="{ body: 'p-0 sm:p-0' }">
          <template #header>
            <h2 class="text-base font-semibold text-highlighted">
              Lokasi
            </h2>
          </template>
          <ClientOnly>
            <CustomerPinpointMap
              :name="doctor.name"
              :latitude="doctor.latitude"
              :longitude="doctor.longitude"
            />
            <template #fallback>
              <div class="flex h-80 items-center justify-center text-muted">
                <UIcon
                  name="i-lucide-loader-circle"
                  class="size-6 animate-spin"
                />
              </div>
            </template>
          </ClientOnly>
        </UCard>
      </div>

      <!-- Profile edit modal -->
      <DoctorProfileModal
        v-model:open="isProfileOpen"
        :profile="doctor.doctor_profile"
        :submitting="mutatingProfile"
        @submit="onProfileSubmit"
      />

      <!-- Assignment create/edit modal -->
      <AssignmentFormModal
        v-model:open="isAssignmentOpen"
        :assignment="editingAssignment"
        :outlet-options="outletOptions"
        :outlets-loading="outletsLoading"
        :submitting="mutatingAssignment"
        @create="onAssignmentCreate"
        @update="onAssignmentUpdate"
      />

      <!-- Delete confirmation modal -->
      <UModal
        v-model:open="isDeleteOpen"
        title="Hapus Afiliasi"
        :description="deletingAssignment
          ? `Hapus afiliasi ke '${deletingAssignment.outlet?.name ?? 'outlet ini'}'?`
          : ''"
        :dismissible="!mutatingAssignment"
      >
        <template #footer>
          <div class="flex w-full justify-end gap-2">
            <UButton
              color="neutral"
              variant="ghost"
              label="Batal"
              :disabled="mutatingAssignment"
              @click="isDeleteOpen = false"
            />
            <UButton
              color="error"
              label="Hapus"
              :loading="mutatingAssignment"
              @click="onConfirmDelete"
            />
          </div>
        </template>
      </UModal>
    </template>
  </div>
</template>
