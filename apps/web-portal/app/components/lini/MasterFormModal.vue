<script setup lang="ts">
/**
 * `MasterFormModal` — create/edit form for a lini or varian, rendered inside a `UModal`.
 *
 * Business lines (`master_lini`) and product variants (`master_varian`) share an identical
 * write contract (`code`, `name`, `description`, `is_active`), so a single presentational
 * modal drives both — the parent picks the entity label via the `entityLabel` prop. The modal
 * owns no persistence: it emits a typed `create`/`update` payload and the parent (via
 * {@link useLini}) performs the API call and list refresh.
 *
 * The open state is controlled by the parent through `v-model:open`. Forced Light Mode is
 * global — no dark-mode classes or `dark:` variants here.
 */
import { computed, reactive, watch } from 'vue'

/** The minimal shape shared by a lini or varian record when editing. */
interface MasterRecord {
  code: string
  name: string
  description: string | null
  is_active: boolean
}

/** Typed create/update payload emitted to the parent (code required on create). */
interface MasterFormPayload {
  code: string
  name: string
  description: string | null
  is_active: boolean
}

const props = defineProps<{
  /** Whether the modal is open (controlled by the parent). */
  open: boolean
  /** The record being edited, or null when creating a new one. */
  record: MasterRecord | null
  /** Human-readable entity label used in titles/copy, e.g. "Lini" or "Varian". */
  entityLabel: string
  /** Whether a submit request is currently in flight (disables the form). */
  submitting: boolean
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  'create': [payload: MasterFormPayload]
  'update': [payload: MasterFormPayload]
}>()

/** True when editing an existing record; false when creating a new one. */
const isEdit = computed<boolean>(() => props.record !== null)

/** Editable draft mirroring the form fields. */
interface MasterDraft {
  code: string
  name: string
  description: string
  is_active: boolean
}

/** Build an empty draft (create mode default). */
function emptyDraft(): MasterDraft {
  return { code: '', name: '', description: '', is_active: true }
}

/** Hydrate a draft from an existing record (edit mode). */
function draftFrom(record: MasterRecord): MasterDraft {
  return {
    code: record.code,
    name: record.name,
    description: record.description ?? '',
    is_active: record.is_active
  }
}

const draft = reactive<MasterDraft>(emptyDraft())

/** Reset the draft whenever the modal (re)opens, so stale edits never leak between rows. */
watch(
  () => [props.open, props.record] as const,
  ([open]) => {
    if (!open) return
    Object.assign(draft, props.record ? draftFrom(props.record) : emptyDraft())
  },
  { immediate: true }
)

/** Trim a string to a value or null (empty → null for the optional description field). */
function orNull(value: string): string | null {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** Whether the required fields (code + name) are satisfied and no submit is in flight. */
const canSubmit = computed<boolean>(() =>
  !props.submitting
  && draft.code.trim().length > 0
  && draft.name.trim().length > 0
)

/** Emit the create/update payload for the parent to persist. */
function onSubmit(): void {
  if (!canSubmit.value) return
  const payload: MasterFormPayload = {
    code: draft.code.trim(),
    name: draft.name.trim(),
    description: orNull(draft.description),
    is_active: draft.is_active
  }
  if (isEdit.value) {
    emit('update', payload)
  } else {
    emit('create', payload)
  }
}

/** Close the modal without persisting. */
function onCancel(): void {
  emit('update:open', false)
}
</script>

<template>
  <UModal
    :open="open"
    :title="isEdit ? `Edit ${entityLabel}` : `Tambah ${entityLabel}`"
    :description="isEdit
      ? `Perbarui data master ${entityLabel.toLowerCase()}.`
      : `Lengkapi data untuk menambahkan ${entityLabel.toLowerCase()} baru.`"
    :dismissible="!submitting"
    @update:open="emit('update:open', $event)"
  >
    <template #body>
      <UForm
        :state="draft"
        class="flex flex-col gap-4"
        @submit="onSubmit"
      >
        <UFormField
          label="Kode"
          name="code"
          required
          :help="`Kode unik ${entityLabel.toLowerCase()} (maks. 50 karakter)`"
        >
          <UInput
            v-model="draft.code"
            :maxlength="50"
            placeholder="mis. FARMA_ETHICAL"
            class="w-full"
          />
        </UFormField>

        <UFormField
          label="Nama"
          name="name"
          required
        >
          <UInput
            v-model="draft.name"
            :maxlength="150"
            :placeholder="`Nama ${entityLabel.toLowerCase()}`"
            class="w-full"
          />
        </UFormField>

        <UFormField
          label="Deskripsi"
          name="description"
        >
          <UTextarea
            v-model="draft.description"
            :rows="2"
            placeholder="Deskripsi opsional"
            class="w-full"
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
