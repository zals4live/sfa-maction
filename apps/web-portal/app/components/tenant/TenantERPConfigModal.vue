<script setup lang="ts">
/**
 * `TenantERPConfigModal` — configure a tenant's ERP gateway, rendered inside a `UModal`.
 *
 * Drives the dedicated `PUT /tenants/:id/erp-config` endpoint (mirrors UpdateERPConfigBody):
 * ERP system type (required), endpoint URL, an optional company code, and an optional
 * `erp_auth_config` credential object. The credentials are entered as raw JSON and parsed on
 * submit; invalid JSON blocks submission with an inline error. Per security.md the credential
 * object is encrypted at rest server-side — this form never persists it locally.
 *
 * The modal owns no persistence: it emits a typed `submit` payload and the parent (via
 * {@link useTenantAdmin}) performs the API call and list refresh. Open state is controlled by
 * the parent through `v-model:open`. Forced Light Mode is global — no `dark:` variants.
 */
import { computed, reactive, ref, watch } from 'vue'
import { ERPSystemType } from '@maction/types'
import type { SelectItem } from '@nuxt/ui'
import type { TenantResponse, UpdateERPConfigInput } from '~/composables/useTenantAdmin'

const props = defineProps<{
  /** Whether the modal is open (controlled by the parent). */
  open: boolean
  /** The tenant whose ERP gateway is being configured. */
  record: TenantResponse | null
  /** Whether a submit request is currently in flight (disables the form). */
  submitting: boolean
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  'submit': [payload: UpdateERPConfigInput]
}>()

/** Placeholder JSON example for the credential textarea (kept in script to avoid quote clashes). */
const authConfigPlaceholder = '{ "client_id": "...", "client_secret": "..." }'

/** ERP system type options for the picker (mirrors the erp_system_enum values). */
const erpTypeItems: SelectItem[] = [
  { label: 'SAP S/4HANA', value: ERPSystemType.SAP_S4HANA },
  { label: 'SAP ECC', value: ERPSystemType.SAP_ECC },
  { label: 'QAD', value: ERPSystemType.QAD },
  { label: 'Custom REST', value: ERPSystemType.CUSTOM_REST }
]

/** Editable draft mirroring the form fields (auth config kept as raw JSON text). */
interface ERPDraft {
  erp_system_type: ERPSystemType
  erp_endpoint_url: string
  erp_company_code: string
  erp_auth_config_text: string
}

/** Build a draft from an existing tenant, or sensible defaults when unset. */
function draftFrom(record: TenantResponse | null): ERPDraft {
  return {
    erp_system_type: record?.erp_system_type ?? ERPSystemType.CUSTOM_REST,
    erp_endpoint_url: record?.erp_endpoint_url ?? '',
    erp_company_code: record?.erp_company_code ?? '',
    erp_auth_config_text: record?.erp_auth_config
      ? JSON.stringify(record.erp_auth_config, null, 2)
      : ''
  }
}

const draft = reactive<ERPDraft>(draftFrom(null))
const jsonError = ref<string | null>(null)

/** Reset the draft whenever the modal (re)opens, so stale edits never leak between tenants. */
watch(
  () => [props.open, props.record] as const,
  ([open]) => {
    if (!open) return
    Object.assign(draft, draftFrom(props.record))
    jsonError.value = null
  },
  { immediate: true }
)

/** Trim a string to a value or null. */
function orNull(value: string): string | null {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** Parse the credential JSON textarea; returns undefined-on-empty or throws on invalid JSON. */
function parseAuthConfig(): Record<string, unknown> | null {
  const text = draft.erp_auth_config_text.trim()
  if (text.length === 0) return null
  const parsed = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Konfigurasi kredensial harus berupa objek JSON.')
  }
  return parsed as Record<string, unknown>
}

/** Whether the required field (system type) is set and no submit is in flight. */
const canSubmit = computed<boolean>(() => !props.submitting && Boolean(draft.erp_system_type))

/** Validate + emit the ERP config payload for the parent to persist. */
function onSubmit(): void {
  if (!canSubmit.value) return
  let authConfig: Record<string, unknown> | null
  try {
    authConfig = parseAuthConfig()
    jsonError.value = null
  } catch (err) {
    jsonError.value = err instanceof Error ? err.message : 'JSON tidak valid.'
    return
  }
  const payload: UpdateERPConfigInput = {
    erp_system_type: draft.erp_system_type,
    erp_endpoint_url: orNull(draft.erp_endpoint_url),
    erp_company_code: orNull(draft.erp_company_code),
    erp_auth_config: authConfig
  }
  emit('submit', payload)
}

/** Close the modal without persisting. */
function onCancel(): void {
  emit('update:open', false)
}
</script>

<template>
  <UModal
    :open="open"
    title="Konfigurasi ERP Gateway"
    :description="record ? `Atur integrasi ERP untuk tenant '${record.name}'.` : ''"
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
          label="Tipe Sistem ERP"
          name="erp_system_type"
          required
        >
          <USelect
            v-model="draft.erp_system_type"
            :items="erpTypeItems"
            value-key="value"
            icon="i-lucide-server-cog"
            class="w-full"
          />
        </UFormField>

        <UFormField
          label="Endpoint URL"
          name="erp_endpoint_url"
          help="URL gateway ERP (kosongkan bila belum tersedia)"
        >
          <UInput
            v-model="draft.erp_endpoint_url"
            placeholder="https://erp.example.com/api"
            class="w-full"
          />
        </UFormField>

        <UFormField
          label="Kode Perusahaan ERP"
          name="erp_company_code"
          help="Kode entitas di sistem ERP (opsional)"
        >
          <UInput
            v-model="draft.erp_company_code"
            :maxlength="50"
            placeholder="mis. 1000"
            class="w-full"
          />
        </UFormField>

        <UFormField
          label="Konfigurasi Kredensial (JSON)"
          name="erp_auth_config"
          help="Objek JSON kredensial; dienkripsi saat disimpan. Kosongkan untuk tidak mengubah."
          :error="jsonError ?? undefined"
        >
          <UTextarea
            v-model="draft.erp_auth_config_text"
            :rows="4"
            :placeholder="authConfigPlaceholder"
            class="w-full font-mono"
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
          label="Simpan Konfigurasi"
          :loading="submitting"
          :disabled="!canSubmit"
          @click="onSubmit"
        />
      </div>
    </template>
  </UModal>
</template>
