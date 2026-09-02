<script setup lang="ts">
// Order cart / taking-order form for the in-visit execution hub — SALESMAN ONLY.
// This is the TAKING_ORDER step. Order-taking is SALESMAN-exclusive: MR is strictly
// forbidden from building carts or submitting orders (mirrors the backend 403 and the
// `useRoleGuard.canTakeOrder` gate). Defense in depth — even though the hub already hides
// this step for MR, the component renders a read-only notice and no interactive cart when
// the user is not a SALESMAN, so a non-SALESMAN never reaches a mutating cart action.
//
// All cart state, money totals, offline persistence, submission, and the SALESMAN guard
// live in `useCartStore` — this SFC never re-implements them. The add-line validation and
// the UOM → base-qty conversion live in the pure `order-cart-form.ts` helper, keeping the
// component thin. Forced light mode (no dark: variants). Tax (PPN) is computed server-side.
import { computed, reactive, watch } from 'vue'
import type { FormError, FormSubmitEvent } from '@nuxt/ui'
import type { MasterMaterial, Order, UserRole } from '@maction/types'
import { formatCurrency } from '@maction/utils'
import { useCartStore } from '~/stores/useCartStore'
import { useRoleGuard } from '~/composables/useRoleGuard'
import type { QueuedMutationResult } from '~/composables/useApiClient'
import {
  buildCartItemInput,
  createEmptyOrderCartForm,
  toBaseQty,
  validateOrderCartForm,
  type OrderCartFormState
} from '~/lib/in-visit/order-cart-form'

/** A material option projected for the `USelectMenu` (`id` value, `name` label). */
interface MaterialOption {
  id: string
  name: string
}

/** Resolves the per-base-UOM price for a material (from cache/API); defaults to 0 when absent. */
type PriceResolver = (material: MasterMaterial) => number

interface Props {
  /** Originating visit the order is logged against (may be null for by-phone contexts). */
  visitId: string
  /** Tenant of the capturing SALESMAN (forwarded to the store's order target/identity). */
  companyId: string
  /** Capturing field user. */
  userId: string
  /** Role of the capturing user — used to gate the interactive cart (SALESMAN only). */
  userRole: UserRole
  /** Customer the order is placed for. */
  customerId: string
  /** Optional doctor the order is associated with (doctor-outlet visits). */
  doctorCustomerId?: string | null
  /** Sales office the order is booked under. */
  sofficeId: string
  /** Lini-scoped material catalog for the picker (from the offline cache). */
  materials?: MasterMaterial[]
  /**
   * Resolve a material's per-base-UOM price. Pricing is not carried on `MasterMaterial`, so
   * the caller supplies it (typically from cached `master_price`); defaults to 0 when the
   * price is not yet known, letting the SALESMAN still capture the line for later repricing.
   */
  priceResolver?: PriceResolver
}

const props = withDefaults(defineProps<Props>(), {
  doctorCustomerId: null,
  materials: () => [],
  priceResolver: () => 0
})

const emit = defineEmits<{
  /** Emitted after the order is saved online or queued offline for background sync. */
  (e: 'saved', result: Order | QueuedMutationResult): void
}>()

const cart = useCartStore()
const { isSalesman } = useRoleGuard({ getRole: () => props.userRole })
const toast = useToast()

const state = reactive<OrderCartFormState>(createEmptyOrderCartForm())

/** Project lini-scoped materials into lightweight `{ id, name }` options for the picker. */
const materialOptions = computed<MaterialOption[]>(() =>
  props.materials.map(material => ({ id: material.id, name: material.name }))
)

/** The currently selected material, resolved from its id (drives UOM options + pricing). */
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

/** Bridge the picker's `string | undefined` model to the form's nullable material field. */
const selectedMaterialId = computed<string | undefined>({
  get: () => state.materialId ?? undefined,
  set: (value) => {
    state.materialId = value ?? null
  }
})

/** Bridge a numeric field to `UInput`'s model (a cleared input yields `null`). */
function numberModel(field: 'qty' | 'discountAmount') {
  return computed<number | undefined>({
    get: () => state[field] ?? undefined,
    set: (value) => {
      state[field] = value === undefined || (value as unknown) === '' ? null : Number(value)
    }
  })
}

const qty = numberModel('qty')
const discountAmount = numberModel('discountAmount')

/** Live base-qty preview for the current selection, or `null` when not yet resolvable. */
const baseQtyPreview = computed<number | null>(() => {
  const material = selectedMaterial.value
  if (!material || state.qty === null) return null
  return toBaseQty(state.qty, state.uom, material.base_uom, material.uom_conversion_rules)
})

/** Bridge the pure validator into the `FormError[]` shape `UForm` renders inline. */
function validate(form: OrderCartFormState): FormError[] {
  return Object.entries(validateOrderCartForm(form)).map(([name, message]) => ({ name, message }))
}

/** Sync the store's order target from the current props (customer/visit/soffice context). */
function syncTarget(): void {
  if (!isSalesman.value) return
  cart.setCustomer({
    customer_id: props.customerId,
    doctor_customer_id: props.doctorCustomerId,
    visit_id: props.visitId,
    soffice_id: props.sofficeId
  })
}

/** Add the current form line to the cart, converting the qty to base units first. */
function onAddItem(event: FormSubmitEvent<OrderCartFormState>): void {
  const material = selectedMaterial.value
  if (!material) return
  const input = buildCartItemInput(event.data, material, props.priceResolver(material))
  if (!input) {
    toast.add({
      title: 'Satuan tidak valid',
      description: 'Konversi satuan untuk material ini tidak ditemukan.',
      color: 'error',
      icon: 'i-lucide-circle-alert'
    })
    return
  }
  cart.addItem(input)
  Object.assign(state, createEmptyOrderCartForm())
}

/** Submit the cart as an order, notifying whether it was saved online or queued offline. */
async function onSubmit(): Promise<void> {
  try {
    const result = await cart.submitOrder()
    emit('saved', result)
    const queued = (result as QueuedMutationResult).queued === true
    toast.add({
      title: queued ? 'Order masuk antrean' : 'Order tersimpan',
      description: queued
        ? 'Order akan dikirim otomatis saat kembali online.'
        : 'Order berhasil dibuat dan dikirim.',
      color: 'success',
      icon: 'i-lucide-circle-check'
    })
  } catch {
    toast.add({
      title: 'Gagal menyimpan order',
      description: 'Terjadi kesalahan. Silakan coba lagi.',
      color: 'error',
      icon: 'i-lucide-circle-alert'
    })
  }
}

// Default the UOM to the selected material's base UOM when the material changes, unless the
// current selection is still valid for the newly chosen material.
watch(selectedMaterial, (material) => {
  if (!material) {
    state.uom = ''
    return
  }
  if (!uomOptions.value.includes(state.uom)) {
    state.uom = material.base_uom
  }
})

// Keep the store's order target in sync with the customer/visit context as props settle.
watch(
  () => [props.customerId, props.doctorCustomerId, props.visitId, props.sofficeId, isSalesman.value],
  syncTarget,
  { immediate: true }
)
</script>

<template>
  <!-- Defense in depth: only a SALESMAN sees the interactive cart. -->
  <div
    v-if="!isSalesman"
    class="flex items-center gap-2 rounded-lg bg-warning-50 p-4 text-warning-700"
  >
    <UIcon
      name="i-lucide-lock"
      class="size-5 shrink-0"
    />
    <p class="text-sm">
      Taking Order hanya untuk Salesman.
    </p>
  </div>

  <div
    v-else
    class="flex flex-col gap-6"
  >
    <!-- Add-to-cart form -->
    <UForm
      :state="state"
      :validate="validate"
      class="flex flex-col gap-4"
      @submit="onAddItem"
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

      <div class="grid grid-cols-2 gap-4">
        <UFormField
          label="Jumlah"
          name="qty"
          required
        >
          <UInput
            v-model="qty"
            type="number"
            :min="1"
            :step="1"
            placeholder="0"
            icon="i-lucide-hash"
            class="w-full"
          />
        </UFormField>

        <UFormField
          label="Satuan (UOM)"
          name="uom"
          required
        >
          <USelectMenu
            v-model="state.uom"
            :items="uomOptions"
            :disabled="uomOptions.length === 0"
            placeholder="Pilih satuan"
            icon="i-lucide-ruler"
            class="w-full"
          />
        </UFormField>
      </div>

      <UFormField
        label="Diskon (Rp)"
        name="discountAmount"
        help="Opsional — potongan harga untuk baris ini."
      >
        <UInput
          v-model="discountAmount"
          type="number"
          :min="0"
          :step="1"
          placeholder="0"
          icon="i-lucide-badge-percent"
          class="w-full"
        />
      </UFormField>

      <p
        v-if="baseQtyPreview !== null"
        class="text-xs text-muted"
      >
        Setara {{ baseQtyPreview }} {{ selectedMaterial?.base_uom }} (satuan dasar).
      </p>

      <UButton
        type="submit"
        block
        size="lg"
        variant="soft"
        icon="i-lucide-plus"
        :disabled="materialOptions.length === 0"
      >
        Tambah ke Keranjang
      </UButton>
    </UForm>

    <!-- Cart line list -->
    <div
      v-if="cart.isEmpty"
      class="rounded-lg bg-elevated p-6 text-center text-sm text-muted"
    >
      Keranjang masih kosong. Tambahkan material di atas.
    </div>

    <ul
      v-else
      class="flex flex-col gap-3"
    >
      <li
        v-for="item in cart.items"
        :key="item.material_id"
        class="flex flex-col gap-2 rounded-lg border border-default p-3"
      >
        <div class="flex items-start justify-between gap-2">
          <div>
            <p class="font-medium">
              {{ item.material_name }}
            </p>
            <p class="text-xs text-muted">
              {{ item.qty }} {{ item.uom }}
            </p>
          </div>
          <UButton
            color="error"
            variant="ghost"
            size="xs"
            icon="i-lucide-trash-2"
            :aria-label="`Hapus ${item.material_name}`"
            @click="cart.removeItem(item.material_id)"
          />
        </div>
        <div class="flex items-center justify-between text-sm">
          <span class="text-muted">Subtotal</span>
          <span>{{ formatCurrency(item.line_subtotal) }}</span>
        </div>
        <div
          v-if="item.discount_amount > 0"
          class="flex items-center justify-between text-sm"
        >
          <span class="text-muted">Diskon</span>
          <span class="text-warning-600">-{{ formatCurrency(item.discount_amount) }}</span>
        </div>
        <div class="flex items-center justify-between text-sm font-medium">
          <span>Total baris</span>
          <span>{{ formatCurrency(item.line_total) }}</span>
        </div>
      </li>
    </ul>

    <!-- Totals footer (read from the store; tax is applied server-side). -->
    <div
      v-if="!cart.isEmpty"
      class="flex flex-col gap-2 rounded-lg bg-elevated p-4"
    >
      <div class="flex items-center justify-between text-sm">
        <span class="text-muted">Subtotal</span>
        <span>{{ formatCurrency(cart.subtotal) }}</span>
      </div>
      <div class="flex items-center justify-between text-sm">
        <span class="text-muted">Total Diskon</span>
        <span class="text-warning-600">-{{ formatCurrency(cart.totalDiscount) }}</span>
      </div>
      <USeparator />
      <div class="flex items-center justify-between font-semibold">
        <span>Grand Total</span>
        <span>{{ formatCurrency(cart.grandTotal) }}</span>
      </div>
      <p class="text-xs text-muted">
        PPN dihitung otomatis oleh sistem saat order diproses.
      </p>
    </div>

    <UButton
      block
      size="lg"
      icon="i-lucide-send"
      :loading="cart.submitting"
      :disabled="cart.isEmpty || cart.submitting"
      @click="onSubmit"
    >
      Kirim Order ({{ cart.itemCount }})
    </UButton>
  </div>
</template>
