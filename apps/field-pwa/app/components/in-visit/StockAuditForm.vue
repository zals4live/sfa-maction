<script setup lang="ts">
// Stock audit form for the in-visit execution hub — SHARED by SALESMAN & MR.
// Both field roles perform shelf/stock audits during visits, so this component is
// role-agnostic (no role gating). It captures the audited material (from the offline,
// lini-scoped catalog), the observed physical stock quantity, its UOM, and an optional
// estimated days-of-stock, then submits to `POST /visits/:id/stock-audits` via
// `useApiClient` — which transparently queues the mutation into the Dexie offline outbox
// (STOCK_AUDIT_CREATE, stamped with the capturing user_role) when the device is offline.
// All validation + payload building lives in the pure `stock-audit-form.ts` helper so the
// SFC stays thin. Forced light mode (no dark: variants).
import { computed, reactive, ref, watch } from 'vue'
import type { FormError, FormSubmitEvent } from '@nuxt/ui'
import type { MasterMaterial, MutationType, UserRole } from '@maction/types'
import { useApiClient, type QueuedMutationResult } from '~/composables/useApiClient'
import type { StockAuditResponse } from '~/lib/in-visit/stock-audit-types'
import {
  buildStockAuditPayload,
  createEmptyStockAuditForm,
  validateStockAuditForm,
  type StockAuditFormState
} from '~/lib/in-visit/stock-audit-form'

/** A material option projected for the `USelectMenu` (`id` value, `name` label). */
interface MaterialOption {
  id: string
  name: string
}

interface Props {
  /** Target visit the stock audit is logged against. */
  visitId: string
  /** Tenant of the capturing field user (stamped on the offline outbox mutation). */
  companyId: string
  /** Capturing field user. */
  userId: string
  /** Role of the capturing user — enables role-adaptive offline sync (not gating). */
  userRole: UserRole
  /**
   * Lini-scoped materials for the required "audited material" picker (from the offline
   * cache). Empty by default; the submit button stays disabled until a catalog is available
   * and a material is chosen.
   */
  materials?: MasterMaterial[]
}

const props = withDefaults(defineProps<Props>(), {
  materials: () => []
})

const emit = defineEmits<{
  /** Emitted after the audit is saved online or queued offline for background sync. */
  (e: 'saved', result: StockAuditResponse | QueuedMutationResult): void
}>()

const STOCK_AUDIT_MUTATION: MutationType = 'STOCK_AUDIT_CREATE'

const api = useApiClient()
const toast = useToast()

const state = reactive<StockAuditFormState>(createEmptyStockAuditForm())
const submitting = ref<boolean>(false)

/** Project lini-scoped materials into lightweight `{ id, name }` options for the picker. */
const materialOptions = computed<MaterialOption[]>(() =>
  props.materials.map(material => ({ id: material.id, name: material.name }))
)

/** The currently selected material, resolved from its id (drives UOM options). */
const selectedMaterial = computed<MasterMaterial | undefined>(() =>
  props.materials.find(material => material.id === state.materialId)
)

/**
 * UOM options for the selected material: its `base_uom` plus any additional units declared
 * in `uom_conversion_rules`, de-duplicated. Empty until a material is chosen.
 */
const uomOptions = computed<string[]>(() => {
  const material = selectedMaterial.value
  if (!material) return []
  const conversionUoms = Object.keys(material.uom_conversion_rules ?? {})
  return Array.from(new Set([material.base_uom, ...conversionUoms]))
})

/**
 * Bridge the picker's `string | undefined` model to the form's nullable field. The backend
 * requires a material, while `USelectMenu` clears to `undefined`.
 */
const selectedMaterialId = computed<string | undefined>({
  get: () => state.materialId ?? undefined,
  set: (value) => {
    state.materialId = value ?? null
  }
})

/**
 * Bridge a numeric field to `UInput`'s model. A cleared number input yields `''` /
 * `undefined`, which the backend treats as "not provided" (`null`).
 */
function qtyModel(field: 'physicalStockQty' | 'estimatedDaysOfStock') {
  return computed<number | undefined>({
    get: () => state[field] ?? undefined,
    set: (value) => {
      state[field] = value === undefined || (value as unknown) === '' ? null : Number(value)
    }
  })
}

const physicalStockQty = qtyModel('physicalStockQty')
const estimatedDaysOfStock = qtyModel('estimatedDaysOfStock')

/** Bridge the pure validator into the `FormError[]` shape `UForm` renders inline. */
function validate(form: StockAuditFormState): FormError[] {
  return Object.entries(validateStockAuditForm(form)).map(([name, message]) => ({ name, message }))
}

/** Reset the form to a blank state after a successful save. */
function resetForm(): void {
  Object.assign(state, createEmptyStockAuditForm())
}

/** Submit the stock audit, queuing offline when there is no network. */
async function onSubmit(event: FormSubmitEvent<StockAuditFormState>): Promise<void> {
  submitting.value = true
  try {
    const result = await api.post<StockAuditResponse>(`/visits/${props.visitId}/stock-audits`, {
      identity: { company_id: props.companyId, user_id: props.userId, user_role: props.userRole },
      mutationType: STOCK_AUDIT_MUTATION,
      monoDeltaMs: typeof performance !== 'undefined' ? performance.now() : 0,
      body: { ...buildStockAuditPayload(event.data) }
    })
    emit('saved', result)
    resetForm()
    toast.add({
      title: 'Audit stok tersimpan',
      description: 'Data stok fisik berhasil dicatat.',
      color: 'success',
      icon: 'i-lucide-circle-check'
    })
  } catch {
    toast.add({
      title: 'Gagal menyimpan audit stok',
      description: 'Terjadi kesalahan. Silakan coba lagi.',
      color: 'error',
      icon: 'i-lucide-circle-alert'
    })
  } finally {
    submitting.value = false
  }
}

// Default the UOM to the selected material's base UOM when it changes, unless the current
// selection is still valid for the newly chosen material.
watch(selectedMaterial, (material) => {
  if (!material) {
    state.uom = ''
    return
  }
  if (!uomOptions.value.includes(state.uom)) {
    state.uom = material.base_uom
  }
})
</script>

<template>
  <UForm
    :state="state"
    :validate="validate"
    class="flex flex-col gap-4"
    @submit="onSubmit"
  >
    <UFormField
      label="Material"
      name="materialId"
      required
    >
      <USelectMenu
        v-model="selectedMaterialId"
        :items="materialOptions"
        value-key="id"
        label-key="name"
        :disabled="materialOptions.length === 0"
        :placeholder="materialOptions.length === 0 ? 'Katalog belum tersedia' : 'Pilih material'"
        icon="i-lucide-pill"
        class="w-full"
      />
    </UFormField>

    <UFormField
      label="Stok Fisik"
      name="physicalStockQty"
      required
    >
      <UInput
        v-model="physicalStockQty"
        type="number"
        :min="0"
        :step="1"
        placeholder="0"
        icon="i-lucide-boxes"
        class="w-full"
      />
    </UFormField>

    <UFormField
      label="Satuan (UOM)"
      name="uom"
      required
    >
      <USelectMenu
        v-if="uomOptions.length > 0"
        v-model="state.uom"
        :items="uomOptions"
        placeholder="Pilih satuan"
        icon="i-lucide-ruler"
        class="w-full"
      />
      <UInput
        v-else
        v-model="state.uom"
        :maxlength="20"
        placeholder="mis. Box"
        icon="i-lucide-ruler"
        class="w-full"
      />
    </UFormField>

    <UFormField
      label="Estimasi Hari Stok"
      name="estimatedDaysOfStock"
      help="Opsional — perkiraan berapa hari stok akan bertahan."
    >
      <UInput
        v-model="estimatedDaysOfStock"
        type="number"
        :min="0"
        :step="1"
        placeholder="0"
        icon="i-lucide-calendar-clock"
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
      Simpan Audit Stok
    </UButton>
  </UForm>
</template>
