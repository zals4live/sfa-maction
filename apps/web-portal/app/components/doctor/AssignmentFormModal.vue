<script setup lang="ts">
/**
 * `AssignmentFormModal` — create/edit a single doctor-outlet affiliation inside a `UModal`.
 *
 * Drives both flows off one reactive draft. On create it exposes an outlet picker
 * (`outlet_customer_id`), which is fixed at creation time and therefore hidden and locked on
 * edit since the backend `UpdateAssignmentBody` omits it. The remaining fields — room/
 * department, practice days, practice window (`HH:MM`), primary-practice flag, and active
 * status — map 1:1 to the create/update contracts of `/doctors/:id/assignments`.
 *
 * The outlet picker is populated by the parent (it owns the outlet fetch via
 * {@link useCustomers}) and passed in via `outletOptions`. Open state is controlled by the
 * parent via `v-model:open`; `create`/`update`/`cancel` hand control back so the parent owns
 * the API call and matrix refresh. Forced Light Mode is global — no `dark:` variants.
 */
import { computed, reactive, watch } from 'vue'
import type { SelectItem } from '@nuxt/ui'
import type {
  CreateAssignmentInput,
  DoctorAssignmentResponse,
  UpdateAssignmentInput
} from '~/composables/useDoctors'

const props = defineProps<{
  /** Whether the modal is open (controlled by the parent). */
  open: boolean
  /** The assignment being edited, or null when creating a new one. */
  assignment: DoctorAssignmentResponse | null
  /** Selectable outlets for the create-mode picker (`{ label, value }`). */
  outletOptions: SelectItem[]
  /** Whether outlets are still loading (disables the picker with a hint). */
  outletsLoading: boolean
  /** Whether a submit request is currently in flight (disables the form). */
  submitting: boolean
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  'create': [payload: CreateAssignmentInput]
  'update': [payload: UpdateAssignmentInput]
}>()

/** True when editing an existing affiliation; false when creating a new one. */
const isEdit = computed(() => props.assignment !== null)

/** Flat, editable draft mirroring the form fields. */
interface AssignmentDraft {
  outlet_customer_id: string
  room_or_department: string
  practice_days: string
  practice_hours_start: string
  practice_hours_end: string
  is_primary_practice: boolean
  is_active: boolean
}

/** Build an empty draft (create mode default). */
function emptyDraft(): AssignmentDraft {
  return {
    outlet_customer_id: '',
    room_or_department: '',
    practice_days: '',
    practice_hours_start: '',
    practice_hours_end: '',
    is_primary_practice: false,
    is_active: true
  }
}

/** Hydrate a draft from an existing assignment (edit mode). */
function draftFrom(assignment: DoctorAssignmentResponse): AssignmentDraft {
  return {
    outlet_customer_id: assignment.outlet_customer_id,
    room_or_department: assignment.room_or_department ?? '',
    practice_days: assignment.practice_days ?? '',
    practice_hours_start: assignment.practice_hours_start ?? '',
    practice_hours_end: assignment.practice_hours_end ?? '',
    is_primary_practice: assignment.is_primary_practice,
    is_active: assignment.is_active
  }
}

const draft = reactive<AssignmentDraft>(emptyDraft())

/** Reset the draft whenever the modal (re)opens so stale edits never leak between rows. */
watch(
  () => [props.open, props.assignment] as const,
  ([open]) => {
    if (!open) return
    Object.assign(draft, props.assignment ? draftFrom(props.assignment) : emptyDraft())
  },
  { immediate: true }
)

/** Trim a string field to a value or null (empty → null for optional API fields). */
function orNull(value: string): string | null {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** Shared, mode-agnostic fields collected from the draft for both create and update. */
function sharedFields(): UpdateAssignmentInput {
  return {
    room_or_department: orNull(draft.room_or_department),
    practice_days: orNull(draft.practice_days),
    practice_hours_start: orNull(draft.practice_hours_start),
    practice_hours_end: orNull(draft.practice_hours_end),
    is_primary_practice: draft.is_primary_practice,
    is_active: draft.is_active
  }
}

/** On create, an outlet must be chosen; on edit it is fixed. */
const canSubmit = computed(() => {
  if (props.submitting) return false
  return isEdit.value || draft.outlet_customer_id.trim().length > 0
})

/** Emit the create/update payload for the parent to persist. */
function onSubmit(): void {
  if (!canSubmit.value) return
  if (isEdit.value) {
    emit('update', sharedFields())
    return
  }
  emit('create', { outlet_customer_id: draft.outlet_customer_id.trim(), ...sharedFields() })
}

/** Close the modal without persisting. */
function onCancel(): void {
  emit('update:open', false)
}
</script>

<template>
  <UModal
    :open="open"
    :title="isEdit ? 'Edit Afiliasi Outlet' : 'Tambah Afiliasi Outlet'"
    :description="isEdit
      ? 'Perbarui detail praktik dokter di outlet ini.'
      : 'Kaitkan dokter dengan outlet praktik baru.'"
    :dismissible="!submitting"
    @update:open="emit('update:open', $event)"
  >
    <template #body>
      <UForm
        :state="draft"
        class="flex flex-col gap-4"
        @submit="onSubmit"
      >
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <UFormField
            v-if="!isEdit"
            label="Outlet"
            name="outlet_customer_id"
            required
            class="sm:col-span-2"
            :help="outletsLoading ? 'Memuat daftar outlet…' : 'Pilih outlet praktik'"
          >
            <USelectMenu
              v-model="draft.outlet_customer_id"
              :items="outletOptions"
              value-key="value"
              :loading="outletsLoading"
              searchable
              placeholder="Pilih outlet"
              class="w-full"
            />
          </UFormField>

          <UFormField
            label="Ruang / Departemen"
            name="room_or_department"
            class="sm:col-span-2"
          >
            <UInput
              v-model="draft.room_or_department"
              placeholder="Contoh: Poli Penyakit Dalam"
              class="w-full"
            />
          </UFormField>

          <UFormField
            label="Hari Praktik"
            name="practice_days"
            class="sm:col-span-2"
          >
            <UInput
              v-model="draft.practice_days"
              placeholder="Contoh: Senin, Rabu, Jumat"
              class="w-full"
            />
          </UFormField>

          <UFormField
            label="Jam Mulai"
            name="practice_hours_start"
          >
            <UInput
              v-model="draft.practice_hours_start"
              type="time"
              class="w-full"
            />
          </UFormField>

          <UFormField
            label="Jam Selesai"
            name="practice_hours_end"
          >
            <UInput
              v-model="draft.practice_hours_end"
              type="time"
              class="w-full"
            />
          </UFormField>

          <UFormField
            label="Praktik Utama"
            name="is_primary_practice"
          >
            <USwitch
              v-model="draft.is_primary_practice"
              :label="draft.is_primary_practice ? 'Ya' : 'Tidak'"
            />
          </UFormField>

          <UFormField
            label="Status"
            name="is_active"
          >
            <USwitch
              v-model="draft.is_active"
              :label="draft.is_active ? 'Aktif' : 'Nonaktif'"
            />
          </UFormField>
        </div>
      </UForm>
    </template>

    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          label="Batal"
          :disabled="submitting"
          @click="onCancel"
        />
        <UButton
          color="primary"
          :label="isEdit ? 'Simpan' : 'Tambah'"
          :loading="submitting"
          :disabled="!canSubmit"
          @click="onSubmit"
        />
      </div>
    </template>
  </UModal>
</template>
