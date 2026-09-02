<script setup lang="ts">
// Detailing / agenda form for the in-visit execution hub — SHARED by SALESMAN & MR.
// Both field roles log detailing topics against a visit, so this component is role-agnostic
// (no role gating). It captures a detailing topic, an optional discussed product, and an
// optional discussion summary, then submits to `POST /visits/:id/agendas` via `useApiClient`
// — which transparently queues the mutation into the Dexie offline outbox (AGENDA_CREATE,
// stamped with the capturing user_role) when the device is offline. All validation +
// payload building lives in the pure `agenda-form.ts` helper so the SFC stays thin.
// Photos map to `photo_s3_key` and are uploaded separately via S3 pre-signed URLs, so they
// are intentionally out of scope for this text form. Forced light mode (no dark: variants).
import { computed, reactive, ref } from 'vue'
import type { FormError, FormSubmitEvent } from '@nuxt/ui'
import type { MasterMaterial, MutationType, UserRole } from '@maction/types'
import { useApiClient, type QueuedMutationResult } from '~/composables/useApiClient'
import type { AgendaResponse } from '~/lib/in-visit/agenda-types'
import {
  buildAgendaPayload,
  createEmptyAgendaForm,
  validateAgendaForm,
  type AgendaFormState
} from '~/lib/in-visit/agenda-form'

/** A product option projected for the `USelectMenu` (`id` value, `name` label). */
interface ProductOption {
  id: string
  name: string
}

interface Props {
  /** Target visit the agenda is logged against. */
  visitId: string
  /** Tenant of the capturing field user (stamped on the offline outbox mutation). */
  companyId: string
  /** Capturing field user. */
  userId: string
  /** Role of the capturing user — enables role-adaptive offline sync. */
  userRole: UserRole
  /**
   * Lini-scoped materials for the optional "discussed product" picker (from the offline
   * cache). Empty by default so the picker is simply omitted when no catalog is available.
   */
  products?: MasterMaterial[]
}

const props = withDefaults(defineProps<Props>(), {
  products: () => []
})

const emit = defineEmits<{
  /** Emitted after the agenda is saved online or queued offline for background sync. */
  (e: 'saved', result: AgendaResponse | QueuedMutationResult): void
}>()

const AGENDA_MUTATION: MutationType = 'AGENDA_CREATE'

const api = useApiClient()
const toast = useToast()

const state = reactive<AgendaFormState>(createEmptyAgendaForm())
const submitting = ref<boolean>(false)

/** Project lini-scoped materials into lightweight `{ id, name }` options for the picker. */
const productOptions = computed<ProductOption[]>(() =>
  props.products.map(material => ({ id: material.id, name: material.name }))
)

/**
 * Bridge the picker's `string | undefined` model to the form's nullable field. The backend
 * treats "no product" as `null`, while `USelectMenu` clears to `undefined`.
 */
const selectedProductId = computed<string | undefined>({
  get: () => state.productDiscussedId ?? undefined,
  set: (value) => {
    state.productDiscussedId = value ?? null
  }
})

/** Bridge the pure validator into the `FormError[]` shape `UForm` renders inline. */
function validate(form: AgendaFormState): FormError[] {
  return Object.entries(validateAgendaForm(form)).map(([name, message]) => ({ name, message }))
}

/** Reset the form to a blank state after a successful save. */
function resetForm(): void {
  Object.assign(state, createEmptyAgendaForm())
}

/** Submit the detailing agenda, queuing offline when there is no network. */
async function onSubmit(event: FormSubmitEvent<AgendaFormState>): Promise<void> {
  submitting.value = true
  try {
    const result = await api.post<AgendaResponse>(`/visits/${props.visitId}/agendas`, {
      identity: { company_id: props.companyId, user_id: props.userId, user_role: props.userRole },
      mutationType: AGENDA_MUTATION,
      monoDeltaMs: typeof performance !== 'undefined' ? performance.now() : 0,
      body: { ...buildAgendaPayload(event.data) }
    })
    emit('saved', result)
    resetForm()
    toast.add({
      title: 'Detailing tersimpan',
      description: 'Agenda detailing berhasil dicatat.',
      color: 'success',
      icon: 'i-lucide-circle-check'
    })
  } catch {
    toast.add({
      title: 'Gagal menyimpan detailing',
      description: 'Terjadi kesalahan. Silakan coba lagi.',
      color: 'error',
      icon: 'i-lucide-circle-alert'
    })
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <UForm
    :state="state"
    :validate="validate"
    class="flex flex-col gap-4"
    @submit="onSubmit"
  >
    <UFormField
      label="Topik Detailing"
      name="topic"
      required
    >
      <UInput
        v-model="state.topic"
        :maxlength="255"
        placeholder="mis. Presentasi produk baru"
        icon="i-lucide-clipboard-list"
        class="w-full"
      />
    </UFormField>

    <UFormField
      v-if="productOptions.length > 0"
      label="Produk yang Dibahas"
      name="productDiscussedId"
      help="Opsional — pilih produk yang dibahas saat detailing."
    >
      <USelectMenu
        v-model="selectedProductId"
        :items="productOptions"
        value-key="id"
        label-key="name"
        placeholder="Pilih produk"
        icon="i-lucide-pill"
        class="w-full"
      />
    </UFormField>

    <UFormField
      label="Ringkasan Diskusi"
      name="discussionSummary"
      help="Opsional — catatan hasil detailing."
    >
      <UTextarea
        v-model="state.discussionSummary"
        :rows="4"
        placeholder="Ringkas poin penting dari detailing ini"
        class="w-full"
      />
    </UFormField>

    <UButton
      type="submit"
      block
      size="lg"
      icon="i-lucide-save"
      :loading="submitting"
      :disabled="submitting"
    >
      Simpan Detailing
    </UButton>
  </UForm>
</template>
