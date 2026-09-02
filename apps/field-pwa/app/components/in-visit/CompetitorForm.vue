<script setup lang="ts">
// Competitor audit form for the in-visit execution hub — SHARED by SALESMAN & MR.
// Both field roles perform competitor intelligence during visits, so this component is
// role-agnostic (no role gating). It captures the competitor brand/product, optional prices
// (to pharmacy & consumer), and optional active-promo notes, then submits to
// `POST /visits/:id/competitor-audits` via `useApiClient` — which transparently queues the
// mutation into the Dexie offline outbox (COMPETITOR_AUDIT_CREATE, stamped with the capturing
// user_role) when the device is offline. All validation + payload building lives in the pure
// `competitor-form.ts` helper so the SFC stays thin. Photos map to `photo_s3_key` and are
// uploaded separately via S3 pre-signed URLs, so they are intentionally out of scope for this
// text form. Forced light mode (no dark: variants).
import { computed, reactive, ref } from 'vue'
import type { FormError, FormSubmitEvent } from '@nuxt/ui'
import type { MutationType, UserRole } from '@maction/types'
import { useApiClient, type QueuedMutationResult } from '~/composables/useApiClient'
import type { CompetitorAuditResponse } from '~/lib/in-visit/competitor-types'
import {
  buildCompetitorAuditPayload,
  createEmptyCompetitorForm,
  validateCompetitorForm,
  type CompetitorFormState
} from '~/lib/in-visit/competitor-form'

interface Props {
  /** Target visit the competitor audit is logged against. */
  visitId: string
  /** Tenant of the capturing field user (stamped on the offline outbox mutation). */
  companyId: string
  /** Capturing field user. */
  userId: string
  /** Role of the capturing user — enables role-adaptive offline sync (not gating). */
  userRole: UserRole
}

const props = defineProps<Props>()

const emit = defineEmits<{
  /** Emitted after the audit is saved online or queued offline for background sync. */
  (e: 'saved', result: CompetitorAuditResponse | QueuedMutationResult): void
}>()

const COMPETITOR_MUTATION: MutationType = 'COMPETITOR_AUDIT_CREATE'

const api = useApiClient()
const toast = useToast()

const state = reactive<CompetitorFormState>(createEmptyCompetitorForm())
const submitting = ref<boolean>(false)

/**
 * Build a two-way bridge between a numeric form field and `UInput`'s model. The backend
 * treats "no price" as `null`, while a cleared number input clears to `''` / `undefined`.
 */
function priceModel(field: 'priceToPharmacy' | 'consumerPrice') {
  return computed<number | undefined>({
    get: () => state[field] ?? undefined,
    set: (value) => {
      state[field] = value === undefined || (value as unknown) === '' ? null : Number(value)
    }
  })
}

const priceToPharmacy = priceModel('priceToPharmacy')
const consumerPrice = priceModel('consumerPrice')

/** Bridge the pure validator into the `FormError[]` shape `UForm` renders inline. */
function validate(form: CompetitorFormState): FormError[] {
  return Object.entries(validateCompetitorForm(form)).map(([name, message]) => ({ name, message }))
}

/** Reset the form to a blank state after a successful save. */
function resetForm(): void {
  Object.assign(state, createEmptyCompetitorForm())
}

/** Submit the competitor audit, queuing offline when there is no network. */
async function onSubmit(event: FormSubmitEvent<CompetitorFormState>): Promise<void> {
  submitting.value = true
  try {
    const result = await api.post<CompetitorAuditResponse>(
      `/visits/${props.visitId}/competitor-audits`,
      {
        identity: { company_id: props.companyId, user_id: props.userId, user_role: props.userRole },
        mutationType: COMPETITOR_MUTATION,
        monoDeltaMs: typeof performance !== 'undefined' ? performance.now() : 0,
        body: { ...buildCompetitorAuditPayload(event.data) }
      }
    )
    emit('saved', result)
    resetForm()
    toast.add({
      title: 'Audit kompetitor tersimpan',
      description: 'Intelijen kompetitor berhasil dicatat.',
      color: 'success',
      icon: 'i-lucide-circle-check'
    })
  } catch {
    toast.add({
      title: 'Gagal menyimpan audit kompetitor',
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
      label="Merek Kompetitor"
      name="competitorBrand"
      required
    >
      <UInput
        v-model="state.competitorBrand"
        :maxlength="150"
        placeholder="mis. Kalbe Farma"
        icon="i-lucide-building-2"
        class="w-full"
      />
    </UFormField>

    <UFormField
      label="Produk Kompetitor"
      name="competitorProduct"
      required
    >
      <UInput
        v-model="state.competitorProduct"
        :maxlength="150"
        placeholder="mis. Promag Tablet"
        icon="i-lucide-package"
        class="w-full"
      />
    </UFormField>

    <UFormField
      label="Harga ke Apotek"
      name="priceToPharmacy"
      help="Opsional — harga jual kompetitor ke apotek."
    >
      <UInput
        v-model="priceToPharmacy"
        type="number"
        :min="0"
        placeholder="0"
        icon="i-lucide-store"
        class="w-full"
      />
    </UFormField>

    <UFormField
      label="Harga Konsumen"
      name="consumerPrice"
      help="Opsional — harga jual kompetitor ke konsumen."
    >
      <UInput
        v-model="consumerPrice"
        type="number"
        :min="0"
        placeholder="0"
        icon="i-lucide-tag"
        class="w-full"
      />
    </UFormField>

    <UFormField
      label="Catatan Promo Aktif"
      name="activePromoNotes"
      help="Opsional — promo atau aktivitas kompetitor yang sedang berjalan."
    >
      <UTextarea
        v-model="state.activePromoNotes"
        :rows="4"
        placeholder="mis. Diskon 10% pembelian minimal 5 box"
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
      Simpan Audit Kompetitor
    </UButton>
  </UForm>
</template>
