<script setup lang="ts">
/**
 * `DoctorProfileModal` — edit a doctor's specialization profile inside a `UModal`.
 *
 * Drives a single reactive draft over the upsert contract of `PATCH /doctors/:id/profile`
 * (see UpdateDoctorProfileBody on the backend): SIP/STR number, specialization,
 * sub-specialization, and free-text notes. Practice schedule is a structured JSON field the
 * backend accepts but this screen does not edit, so it is intentionally omitted here rather
 * than surfaced as raw JSON.
 *
 * Open state is controlled by the parent via `v-model:open`; `submit`/`cancel` hand control
 * back so the parent (doctor 360 page) owns the API call and refresh. Purely presentational
 * over a flat draft. Forced Light Mode is global — no `dark:` variants.
 */
import { reactive, watch } from 'vue'
import type { DoctorProfileInput, DoctorProfileResponse } from '~/composables/useDoctors'

const props = defineProps<{
  /** Whether the modal is open (controlled by the parent). */
  open: boolean
  /** The doctor's current profile, or null when none exists yet (first-time upsert). */
  profile: DoctorProfileResponse | null
  /** Whether a submit request is currently in flight (disables the form). */
  submitting: boolean
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  'submit': [payload: DoctorProfileInput]
}>()

/** Flat, editable draft mirroring the editable profile fields. */
interface ProfileDraft {
  sip_str_number: string
  specialization: string
  sub_specialization: string
  notes: string
}

/** Build an empty draft (no profile yet). */
function emptyDraft(): ProfileDraft {
  return { sip_str_number: '', specialization: '', sub_specialization: '', notes: '' }
}

/** Hydrate a draft from an existing profile. */
function draftFrom(profile: DoctorProfileResponse): ProfileDraft {
  return {
    sip_str_number: profile.sip_str_number ?? '',
    specialization: profile.specialization ?? '',
    sub_specialization: profile.sub_specialization ?? '',
    notes: profile.notes ?? ''
  }
}

const draft = reactive<ProfileDraft>(emptyDraft())

/** Reset the draft whenever the modal (re)opens so stale edits never leak. */
watch(
  () => [props.open, props.profile] as const,
  ([open]) => {
    if (!open) return
    Object.assign(draft, props.profile ? draftFrom(props.profile) : emptyDraft())
  },
  { immediate: true }
)

/** Trim a string field to a value or null (empty → null for optional API fields). */
function orNull(value: string): string | null {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** Emit the profile upsert payload for the parent to persist. */
function onSubmit(): void {
  if (props.submitting) return
  emit('submit', {
    sip_str_number: orNull(draft.sip_str_number),
    specialization: orNull(draft.specialization),
    sub_specialization: orNull(draft.sub_specialization),
    notes: orNull(draft.notes)
  })
}

/** Close the modal without persisting. */
function onCancel(): void {
  emit('update:open', false)
}
</script>

<template>
  <UModal
    :open="open"
    title="Edit Profil Dokter"
    description="Perbarui data spesialisasi dan lisensi dokter."
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
            label="Spesialisasi"
            name="specialization"
          >
            <UInput
              v-model="draft.specialization"
              placeholder="Contoh: Penyakit Dalam"
              class="w-full"
            />
          </UFormField>

          <UFormField
            label="Sub-spesialisasi"
            name="sub_specialization"
          >
            <UInput
              v-model="draft.sub_specialization"
              placeholder="Contoh: Gastroenterologi"
              class="w-full"
            />
          </UFormField>

          <UFormField
            label="No. SIP/STR"
            name="sip_str_number"
            class="sm:col-span-2"
          >
            <UInput
              v-model="draft.sip_str_number"
              placeholder="Nomor Surat Izin Praktik / STR"
              class="w-full"
            />
          </UFormField>

          <UFormField
            label="Catatan"
            name="notes"
            class="sm:col-span-2"
          >
            <UTextarea
              v-model="draft.notes"
              :rows="3"
              placeholder="Catatan tambahan"
              class="w-full"
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
          label="Simpan"
          :loading="submitting"
          @click="onSubmit"
        />
      </div>
    </template>
  </UModal>
</template>
