<script setup lang="ts">
/**
 * `CustomerFormModal` — create/edit form for a customer, rendered inside a `UModal`.
 *
 * Drives both the create and edit flows off a single reactive draft. On create it exposes the
 * fields fixed at creation time (`customer_type`, `soffice_id`), which are hidden and locked on
 * edit since the backend `UpdateCustomerBody` omits them. Coordinates are edited as flat
 * `latitude`/`longitude`; the parent (via `useCustomers`) folds them into the API's nested
 * `location` shape, so this component stays purely presentational over a flat draft.
 *
 * The modal's open state is controlled by the parent via `v-model:open`; `submit`/`cancel`
 * events hand control back so the parent owns the API call and list refresh. Forced Light Mode
 * is global — no dark-mode classes or `dark:` variants here.
 */
import { computed, reactive, watch } from 'vue'
import type { SelectItem } from '@nuxt/ui'
import type {
  CreateCustomerInput,
  CustomerResponse,
  CustomerTypeValue,
  UpdateCustomerInput
} from '~/composables/useCustomers'

const props = defineProps<{
  /** Whether the modal is open (controlled by the parent). */
  open: boolean
  /** The customer being edited, or null when creating a new one. */
  customer: CustomerResponse | null
  /** Whether a submit request is currently in flight (disables the form). */
  submitting: boolean
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  'create': [payload: CreateCustomerInput]
  'update': [payload: UpdateCustomerInput]
}>()

/** True when editing an existing record; false when creating a new one. */
const isEdit = computed(() => props.customer !== null)

/** Flat, editable draft mirroring the form fields (coordinates flat, folded on submit). */
interface CustomerDraft {
  customer_type: CustomerTypeValue
  soffice_id: string
  name: string
  erp_customer_code: string
  customer_group: string
  address: string
  city: string
  latitude: string
  longitude: string
  credit_limit: string
  credit_term_days: string
  is_active: boolean
}

/** Build an empty draft (create mode default). */
function emptyDraft(): CustomerDraft {
  return {
    customer_type: 'OUTLET',
    soffice_id: '',
    name: '',
    erp_customer_code: '',
    customer_group: '',
    address: '',
    city: '',
    latitude: '',
    longitude: '',
    credit_limit: '',
    credit_term_days: '',
    is_active: true
  }
}

/** Hydrate a draft from an existing customer (edit mode). */
function draftFrom(customer: CustomerResponse): CustomerDraft {
  return {
    customer_type: customer.customer_type,
    soffice_id: customer.soffice_id,
    name: customer.name,
    erp_customer_code: customer.erp_customer_code ?? '',
    customer_group: customer.customer_group ?? '',
    address: customer.address ?? '',
    city: customer.city ?? '',
    latitude: customer.latitude?.toString() ?? '',
    longitude: customer.longitude?.toString() ?? '',
    credit_limit: customer.credit_limit?.toString() ?? '',
    credit_term_days: customer.credit_term_days?.toString() ?? '',
    is_active: customer.is_active
  }
}

const draft = reactive<CustomerDraft>(emptyDraft())

/** Reset the draft whenever the modal (re)opens, so stale edits never leak between rows. */
watch(
  () => [props.open, props.customer] as const,
  ([open]) => {
    if (!open) return
    Object.assign(draft, props.customer ? draftFrom(props.customer) : emptyDraft())
  },
  { immediate: true }
)

const customerTypeItems: SelectItem[] = [
  { label: 'Outlet', value: 'OUTLET' },
  { label: 'Dokter', value: 'DOCTOR' },
  { label: 'Komunitas', value: 'COMMUNITY' },
  { label: 'Event', value: 'EVENT' }
]

/** Trim a string field to a value or null (empty → null for optional API fields). */
function orNull(value: string): string | null {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** Parse a numeric text field to a number or null (blank/invalid → null). */
function numberOrNull(value: string): number | null {
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

/** Shared, type-agnostic fields collected from the draft for both create and update. */
function sharedFields(): Omit<UpdateCustomerInput, 'name'> {
  return {
    erp_customer_code: orNull(draft.erp_customer_code),
    customer_group: orNull(draft.customer_group),
    address: orNull(draft.address),
    city: orNull(draft.city),
    latitude: numberOrNull(draft.latitude),
    longitude: numberOrNull(draft.longitude),
    credit_limit: numberOrNull(draft.credit_limit),
    credit_term_days: numberOrNull(draft.credit_term_days),
    is_active: draft.is_active
  }
}

/** Whether the required fields for the active mode are satisfied. */
const canSubmit = computed(() => {
  if (props.submitting || draft.name.trim().length === 0) return false
  return isEdit.value || draft.soffice_id.trim().length > 0
})

/** Emit the create/update payload for the parent to persist. */
function onSubmit(): void {
  if (!canSubmit.value) return
  if (isEdit.value) {
    emit('update', { name: draft.name.trim(), ...sharedFields() })
    return
  }
  emit('create', {
    customer_type: draft.customer_type,
    soffice_id: draft.soffice_id.trim(),
    name: draft.name.trim(),
    ...sharedFields()
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
    :title="isEdit ? 'Edit Pelanggan' : 'Tambah Pelanggan'"
    :description="isEdit
      ? 'Perbarui data master pelanggan.'
      : 'Lengkapi data untuk mendaftarkan pelanggan baru.'"
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
            label="Tipe Pelanggan"
            name="customer_type"
            required
          >
            <USelect
              v-model="draft.customer_type"
              :items="customerTypeItems"
              value-key="value"
              class="w-full"
            />
          </UFormField>

          <UFormField
            v-if="!isEdit"
            label="Sales Office ID"
            name="soffice_id"
            required
            help="UUID kantor penjualan"
          >
            <UInput
              v-model="draft.soffice_id"
              placeholder="uuid soffice"
              class="w-full"
            />
          </UFormField>

          <UFormField
            label="Nama"
            name="name"
            required
            class="sm:col-span-2"
          >
            <UInput
              v-model="draft.name"
              placeholder="Nama pelanggan"
              class="w-full"
            />
          </UFormField>

          <UFormField
            label="Kode ERP"
            name="erp_customer_code"
          >
            <UInput
              v-model="draft.erp_customer_code"
              placeholder="Kode pelanggan ERP"
              class="w-full"
            />
          </UFormField>

          <UFormField
            label="Grup Pelanggan"
            name="customer_group"
          >
            <UInput
              v-model="draft.customer_group"
              placeholder="Grup"
              class="w-full"
            />
          </UFormField>

          <UFormField
            label="Alamat"
            name="address"
            class="sm:col-span-2"
          >
            <UTextarea
              v-model="draft.address"
              :rows="2"
              placeholder="Alamat lengkap"
              class="w-full"
            />
          </UFormField>

          <UFormField
            label="Kota"
            name="city"
          >
            <UInput
              v-model="draft.city"
              placeholder="Kota"
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

          <UFormField
            label="Latitude"
            name="latitude"
          >
            <UInput
              v-model="draft.latitude"
              type="number"
              step="any"
              placeholder="-6.20"
              class="w-full"
            />
          </UFormField>

          <UFormField
            label="Longitude"
            name="longitude"
          >
            <UInput
              v-model="draft.longitude"
              type="number"
              step="any"
              placeholder="106.80"
              class="w-full"
            />
          </UFormField>

          <UFormField
            label="Limit Kredit"
            name="credit_limit"
          >
            <UInput
              v-model="draft.credit_limit"
              type="number"
              step="any"
              placeholder="0"
              class="w-full"
            />
          </UFormField>

          <UFormField
            label="Tempo Kredit (hari)"
            name="credit_term_days"
          >
            <UInput
              v-model="draft.credit_term_days"
              type="number"
              placeholder="0"
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
