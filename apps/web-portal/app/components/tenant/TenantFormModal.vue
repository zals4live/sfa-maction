<script setup lang="ts">
/**
 * `TenantFormModal` — create/edit form for a tenant company, rendered inside a `UModal`.
 *
 * Covers tenant identity (code, name) and branding/operational settings (logo S3 key, default
 * PPN tax rate, geofence radius, minimum checkout hour). The write contract differs by mode,
 * mirroring the backend:
 *  - CREATE (`POST /tenants`): all identity + branding fields. `code` is required and editable.
 *  - EDIT (`PATCH /tenants/:id`): the same branding fields. ERP gateway settings are NOT edited
 *    here — they live in the dedicated ERP config modal (`PUT /tenants/:id/erp-config`).
 *
 * The modal owns no persistence: it emits a typed `create`/`update` payload (only the fields the
 * respective backend endpoint accepts) and the parent (via {@link useTenantAdmin}) performs the
 * API call and list refresh. Open state is controlled by the parent through `v-model:open`.
 * Forced Light Mode is global — no `dark:` variants.
 */
import { computed, reactive, watch } from 'vue'
import type { CreateTenantInput, TenantResponse, UpdateTenantInput } from '~/composables/useTenantAdmin'

const props = defineProps<{
  /** Whether the modal is open (controlled by the parent). */
  open: boolean
  /** The tenant being edited, or null when creating a new one. */
  record: TenantResponse | null
  /** Whether a submit request is currently in flight (disables the form). */
  submitting: boolean
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  'create': [payload: CreateTenantInput]
  'update': [payload: UpdateTenantInput]
}>()

/** True when editing an existing tenant; false when creating a new one. */
const isEdit = computed<boolean>(() => props.record !== null)

/** Default operational values (match backend column defaults). */
const DEFAULT_TAX_RATE = 11
const DEFAULT_GEOFENCE = 100
const DEFAULT_CHECKOUT_HOUR = 16

/** Editable draft mirroring the form fields (numbers kept as numbers for UInput type=number). */
interface TenantDraft {
  code: string
  name: string
  logo_s3_key: string
  default_tax_rate: number
  geofence_radius_meters: number
  checkout_min_hour: number
}

/** Build an empty draft (create-mode defaults). */
function emptyDraft(): TenantDraft {
  return {
    code: '',
    name: '',
    logo_s3_key: '',
    default_tax_rate: DEFAULT_TAX_RATE,
    geofence_radius_meters: DEFAULT_GEOFENCE,
    checkout_min_hour: DEFAULT_CHECKOUT_HOUR
  }
}

/** Hydrate a draft from an existing tenant (edit mode). */
function draftFrom(record: TenantResponse): TenantDraft {
  return {
    code: record.code,
    name: record.name,
    logo_s3_key: record.logo_s3_key ?? '',
    default_tax_rate: record.default_tax_rate,
    geofence_radius_meters: record.geofence_radius_meters,
    checkout_min_hour: record.checkout_min_hour
  }
}

const draft = reactive<TenantDraft>(emptyDraft())

/** Reset the draft whenever the modal (re)opens, so stale edits never leak between rows. */
watch(
  () => [props.open, props.record] as const,
  ([open]) => {
    if (!open) return
    Object.assign(draft, props.record ? draftFrom(props.record) : emptyDraft())
  },
  { immediate: true }
)

/** Trim a string to a value or null (empty → null for the optional logo key). */
function orNull(value: string): string | null {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** Whether identity + branding constraints are satisfied and no submit is in flight. */
const canSubmit = computed<boolean>(() =>
  !props.submitting
  && draft.code.trim().length > 0
  && draft.name.trim().length > 0
  && draft.default_tax_rate >= 0 && draft.default_tax_rate <= 100
  && draft.geofence_radius_meters >= 1
  && draft.checkout_min_hour >= 0 && draft.checkout_min_hour <= 23
)

/** Emit the create/update payload for the parent to persist. */
function onSubmit(): void {
  if (!canSubmit.value) return
  if (isEdit.value) {
    const payload: UpdateTenantInput = {
      code: draft.code.trim(),
      name: draft.name.trim(),
      logo_s3_key: orNull(draft.logo_s3_key),
      default_tax_rate: draft.default_tax_rate,
      geofence_radius_meters: draft.geofence_radius_meters,
      checkout_min_hour: draft.checkout_min_hour
    }
    emit('update', payload)
  } else {
    const payload: CreateTenantInput = {
      code: draft.code.trim(),
      name: draft.name.trim(),
      logo_s3_key: orNull(draft.logo_s3_key),
      default_tax_rate: draft.default_tax_rate,
      geofence_radius_meters: draft.geofence_radius_meters,
      checkout_min_hour: draft.checkout_min_hour
    }
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
    :title="isEdit ? 'Edit Tenant' : 'Tambah Tenant'"
    :description="isEdit
      ? 'Perbarui identitas dan pengaturan branding tenant.'
      : 'Provisikan tenant baru dengan identitas dan pengaturan branding.'"
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
            label="Kode"
            name="code"
            required
            help="Kode unik tenant (maks. 50 karakter)"
          >
            <UInput
              v-model="draft.code"
              :maxlength="50"
              placeholder="mis. KFTD"
              class="w-full"
            />
          </UFormField>

          <UFormField
            label="Nama Tenant"
            name="name"
            required
          >
            <UInput
              v-model="draft.name"
              :maxlength="255"
              placeholder="Nama perusahaan tenant"
              class="w-full"
            />
          </UFormField>
        </div>

        <UFormField
          label="Logo (S3 Key)"
          name="logo_s3_key"
          help="Kunci objek S3 untuk logo tenant (opsional)"
        >
          <UInput
            v-model="draft.logo_s3_key"
            placeholder="mis. {company_id}/branding/logo.png"
            class="w-full"
          />
        </UFormField>

        <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <UFormField
            label="PPN (%)"
            name="default_tax_rate"
            help="0–100"
          >
            <UInput
              v-model.number="draft.default_tax_rate"
              type="number"
              :min="0"
              :max="100"
              :step="0.1"
              class="w-full"
            />
          </UFormField>

          <UFormField
            label="Radius Geofence (m)"
            name="geofence_radius_meters"
            help="Minimal 1 meter"
          >
            <UInput
              v-model.number="draft.geofence_radius_meters"
              type="number"
              :min="1"
              class="w-full"
            />
          </UFormField>

          <UFormField
            label="Jam Checkout Min."
            name="checkout_min_hour"
            help="Jam 0–23"
          >
            <UInput
              v-model.number="draft.checkout_min_hour"
              type="number"
              :min="0"
              :max="23"
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
          :label="isEdit ? 'Simpan' : 'Tambah'"
          :loading="submitting"
          :disabled="!canSubmit"
          @click="onSubmit"
        />
      </div>
    </template>
  </UModal>
</template>
