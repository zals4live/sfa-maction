<script setup lang="ts">
// By-phone order entry page — SALESMAN ONLY (the `/app/orders` "Pesanan" tab).
// Order-taking is SALESMAN-EXCLUSIVE. Unlike the in-visit OrderCart there is NO active visit:
// the SALESMAN picks a cached customer, then builds the same cart (reusing OrderCart with a
// null visitId — the by-phone context). Defense in depth mirrors OrderCart.vue:
//   1. The `salesman-only` route middleware redirects non-SALESMAN before the page renders.
//   2. This template still renders a read-only notice when `!isSalesman`, so a non-SALESMAN
//      who somehow reaches the route never sees the interactive form.
// The page is intentionally thin: identity comes from `useAuthStore`, role from
// `useRoleGuard`, cached data from `useOfflineDb`, and all cart logic lives in OrderCart /
// `useCartStore`. Read-side shaping lives in the pure `order-entry.ts` helper.
// Forced light mode (no dark: variants); Indonesian copy.
import { computed, onMounted, ref } from 'vue'
import { BusinessLine } from '@maction/types'
import type { MasterMaterial, Order } from '@maction/types'
import { useAuthStore } from '~/stores/useAuthStore'
import { useCartStore } from '~/stores/useCartStore'
import { useRoleGuard } from '~/composables/useRoleGuard'
import { useOfflineDb } from '~/composables/useOfflineDb'
import type { QueuedMutationResult } from '~/composables/useApiClient'
import { dedupeMaterials, toCustomerOptions, type CustomerOption } from './order-entry'

definePageMeta({
  middleware: 'salesman-only',
  layout: 'default'
})

const auth = useAuthStore()
const cart = useCartStore()
const db = useOfflineDb()
const { isSalesman } = useRoleGuard({ getRole: () => auth.role })
const toast = useToast()

/** Cached, active customers projected into picker options. */
const customerOptions = ref<CustomerOption[]>([])
/** Lini-scoped material catalog (cached on sync) for the OrderCart picker. */
const materials = ref<MasterMaterial[]>([])
/** The customer the by-phone order is being placed for. */
const selectedCustomerId = ref<string | undefined>(undefined)

/** Whether a customer has been chosen (gates rendering of the cart). */
const hasCustomer = computed(() => Boolean(selectedCustomerId.value))

/** Load the cached customers for the picker (active, non-deleted rows only). */
async function loadCustomers(companyId: string): Promise<void> {
  const rows = await db.listCustomersByCompany(companyId)
  customerOptions.value = toCustomerOptions(rows)
}

/** Load the cached catalog across every business line, de-duplicated by material id. */
async function loadMaterials(companyId: string): Promise<void> {
  const perLine = await Promise.all(
    Object.values(BusinessLine).map(line => db.listMaterialsByBusinessLine(companyId, line))
  )
  materials.value = dedupeMaterials(perLine.flat())
}

/** Toast + reset the customer selection after an order is saved or queued offline. */
function onSaved(result: Order | QueuedMutationResult): void {
  const queued = (result as QueuedMutationResult).queued === true
  toast.add({
    title: queued ? 'Order masuk antrean' : 'Order tersimpan',
    description: queued
      ? 'Order via telepon akan dikirim otomatis saat kembali online.'
      : 'Order via telepon berhasil dibuat.',
    color: 'success',
    icon: 'i-lucide-circle-check'
  })
  selectedCustomerId.value = undefined
  if (queued) cart.reset()
}

onMounted(async () => {
  if (!isSalesman.value) return
  const companyId = auth.companyId
  if (!companyId) return
  await Promise.all([loadCustomers(companyId), loadMaterials(companyId)])
})
</script>

<template>
  <UContainer class="flex flex-col gap-5 py-5">
    <div class="flex flex-col gap-1">
      <h1 class="text-xl font-semibold text-primary">
        Order via Telepon
      </h1>
      <p class="text-sm text-muted">
        Buat pesanan untuk pelanggan tanpa kunjungan langsung.
      </p>
    </div>

    <!-- Defense in depth: only a SALESMAN sees the interactive order entry. -->
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

    <template v-else>
      <!-- Step 1: pick the customer the order is placed for. -->
      <UCard>
        <template #header>
          <div class="flex items-center gap-2">
            <UIcon
              name="i-lucide-store"
              class="size-5 text-primary"
            />
            <h2 class="text-sm font-semibold text-highlighted">
              Pilih Pelanggan
            </h2>
          </div>
        </template>

        <USelectMenu
          v-model="selectedCustomerId"
          :items="customerOptions"
          value-key="id"
          label-key="name"
          :disabled="customerOptions.length === 0"
          :placeholder="customerOptions.length === 0 ? 'Pelanggan belum tersedia' : 'Cari pelanggan'"
          icon="i-lucide-search"
          class="w-full"
        />
      </UCard>

      <!-- Prompt until a customer is chosen. -->
      <UAlert
        v-if="!hasCustomer"
        icon="i-lucide-info"
        color="primary"
        variant="subtle"
        title="Pilih pelanggan dahulu"
        description="Tentukan pelanggan untuk mulai menyusun keranjang order."
      />

      <!-- Step 2: build the cart (reuses the in-visit OrderCart; visitId is null by-phone). -->
      <UCard v-else>
        <template #header>
          <div class="flex items-center gap-2">
            <UIcon
              name="i-lucide-shopping-cart"
              class="size-5 text-primary"
            />
            <h2 class="text-sm font-semibold text-highlighted">
              Keranjang Order
            </h2>
          </div>
        </template>

        <InVisitOrderCart
          :visit-id="''"
          :company-id="auth.companyId ?? ''"
          :user-id="auth.userId ?? ''"
          :user-role="auth.role!"
          :customer-id="selectedCustomerId!"
          :soffice-id="auth.sofficeId ?? ''"
          :materials="materials"
          @saved="onSaved"
        />
      </UCard>
    </template>
  </UContainer>
</template>
