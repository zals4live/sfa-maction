<script setup lang="ts">
// In-visit execution HUB for a single planned visit (SALESMAN & MR). This page is the
// orchestrator that lays out the role-adaptive tabbed steps and routes navigation between
// them — it does NOT implement the individual step forms. Those are separate downstream tasks
// (AgendaForm / CompetitorForm / StockAuditForm / OrderCart / PriceStockLookup), so each tab
// here renders a lightweight placeholder panel that a later task drops its component into.
//
// The page is intentionally THIN: all logic lives in composables + the pure `in-visit.ts`
// helpers, mirroring the sibling `visit-in.vue`.
//   - `useRoleGuard.inVisitSteps` is the SINGLE SOURCE OF TRUTH for the step set + ordering:
//       SALESMAN: Detailing → Kompetitor → Audit Stok → Ambil Order
//       MR:       Detailing → Info Harga & Stok (read-only) → Kompetitor  (no Taking Order)
//     No raw `role === ...` checks live here — the SALESMAN order / MR read-only boundary is
//     entirely derived from the guard.
//   - `useVisits` resolves today's plan by route id (offline-first), matching `visit-in.vue`.
//   - The pure `buildInVisitTabs` helper decorates the guard's ordered steps into UTabs items.
// Forced light mode (no dark: variants).
import { computed, onMounted, ref } from 'vue'
import type { MasterCustomer, VisitPlan } from '@maction/types'
import { useRoleGuard } from '~/composables/useRoleGuard'
import { useVisits } from '~/composables/useVisits'
import { useOfflineDb } from '~/composables/useOfflineDb'
import { buildInVisitTabs, type InVisitTabItem } from '~/pages/app/visits/[id]/in-visit'

definePageMeta({
  layout: 'default'
})

const route = useRoute()
const roleGuard = useRoleGuard()
const visits = useVisits()
const db = useOfflineDb()

const planId = computed(() => String(route.params.id))
const plan = ref<VisitPlan | null>(null)
const customer = ref<MasterCustomer | null>(null)
const loading = ref(true)

/** Role-adaptive tab set, driven entirely by `useRoleGuard.inVisitSteps` (order preserved). */
const tabs = computed<InVisitTabItem[]>(() => buildInVisitTabs(roleGuard.inVisitSteps.value))

/** Resolve today's plan by route id and load its target customer for the summary header. */
async function loadPlan(): Promise<void> {
  loading.value = true
  await visits.load()
  const match = visits.items.value.find(item => item.plan.id === planId.value)
  plan.value = match?.plan ?? null
  if (plan.value) {
    customer.value = (await db.getCustomer(plan.value.company_id, plan.value.customer_id)) ?? null
  }
  loading.value = false
}

onMounted(async () => {
  // Keep the guard's derived role in sync with the current session before building tabs.
  roleGuard.refresh()
  await loadPlan()
})
</script>

<template>
  <UContainer class="flex flex-col gap-5 py-5">
    <div class="flex flex-col gap-1">
      <h1 class="text-xl font-semibold text-primary">
        Eksekusi Kunjungan
      </h1>
      <p class="text-sm text-muted">
        Selesaikan setiap langkah kunjungan sesuai peran Anda.
      </p>
    </div>

    <!-- Loading skeleton while the plan + target resolve. -->
    <USkeleton
      v-if="loading"
      class="h-72 w-full rounded-lg"
    />

    <!-- Plan not found for this route id. -->
    <UAlert
      v-else-if="!plan"
      icon="i-lucide-circle-alert"
      color="error"
      variant="subtle"
      title="Kunjungan tidak ditemukan"
      description="Rencana kunjungan ini tidak tersedia. Kembali ke daftar kunjungan."
      :actions="[{ label: 'Daftar Kunjungan', color: 'error', variant: 'solid', to: '/app/visits' }]"
    />

    <template v-else>
      <!-- Target customer summary header. -->
      <UCard>
        <div class="flex items-start gap-3">
          <UIcon
            name="i-lucide-map-pin"
            class="mt-0.5 size-5 text-primary"
          />
          <div class="flex flex-col gap-0.5">
            <span class="text-sm font-semibold text-highlighted">
              {{ customer?.name ?? 'Pelanggan tidak dikenal' }}
            </span>
            <span
              v-if="customer?.address"
              class="text-xs text-muted"
            >
              {{ customer.address }}
            </span>
          </div>
        </div>
      </UCard>

      <!-- Role unknown / no steps resolved (e.g. session not ready). -->
      <UAlert
        v-if="tabs.length === 0"
        icon="i-lucide-circle-alert"
        color="warning"
        variant="subtle"
        title="Langkah kunjungan tidak tersedia"
        description="Peran pengguna belum dikenali. Silakan masuk kembali."
      />

      <!--
        Role-adaptive tabbed steps. The tab set + ordering come from `useRoleGuard`; each tab's
        content is a placeholder panel. Later tasks replace the placeholder inside each named
        slot with the real step component (AgendaForm / CompetitorForm / StockAuditForm /
        OrderCart / PriceStockLookup).
      -->
      <UTabs
        v-else
        :items="tabs"
        :default-value="tabs[0]?.value"
        variant="link"
        class="w-full"
      >
        <template
          v-for="tab in tabs"
          #[tab.slot]="{ item }"
          :key="tab.value"
        >
          <UCard :ui="{ body: 'p-6' }">
            <div class="flex flex-col items-center gap-2 py-6 text-center text-muted">
              <UIcon
                :name="item.icon"
                class="size-10 text-primary"
              />
              <p class="text-sm font-semibold text-highlighted">
                {{ item.label }}
              </p>
              <p class="text-xs">
                Langkah ini akan segera tersedia.
              </p>
            </div>
          </UCard>
        </template>
      </UTabs>

      <!--
        Entry point into the visit-out (completion) flow. Role-agnostic — both SALESMAN & MR
        close a visit here. The dedicated `[id]/visit-out.vue` page captures the customer
        signature, a trustworthy GPS fix, and a monotonic timestamp before recording visit-out.
      -->
      <UButton
        block
        size="lg"
        variant="outline"
        icon="i-lucide-door-closed"
        :to="`/app/visits/${planId}/visit-out`"
      >
        Selesaikan Kunjungan
      </UButton>
    </template>
  </UContainer>
</template>
