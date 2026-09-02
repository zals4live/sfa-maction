<script setup lang="ts">
// Visit-in geofence gate for a single planned visit (SALESMAN & MR). This is the proximity
// check that precedes the in-visit execution hub: the field user must be inside the target
// outlet/doctor geofence before the visit can start. The page is intentionally THIN — all
// logic lives in composables and the pure `visit-in.ts` helpers:
//   - `useVisits` resolves today's plan by route id (offline-first).
//   - `useOfflineDb.getCustomer` yields the target's `location_geom` for the geofence.
//   - `useGeofence` computes distance / radius membership / proximity for the radar.
//   - `useAntiSpoof` runs Layer 1 (mock/accuracy) + Layer 2 (monotonic clock) checks.
//   - `useApiClient.post('/visits/start', ...)` performs the visit-in online, falling back to
//     the offline outbox (VISIT_IN) so the flow works with no network. The payload carries
//     `customer_id` so `visit-status.ts` can derive IN_PROGRESS from the queued mutation.
// Outside the radius the action is SOFT-rejected (blocked, non-aggressive toast) — never a ban.
// Forced light mode (no dark: variants).
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { MasterCustomer, MutationType, VisitPlan } from '@maction/types'
import { useGeofence } from '~/composables/useGeofence'
import { useAntiSpoof, type EvaluatedPosition } from '~/composables/useAntiSpoof'
import { useVisits } from '~/composables/useVisits'
import { useOfflineDb } from '~/composables/useOfflineDb'
import { useApiClient, type QueuedMutationResult } from '~/composables/useApiClient'
import { useAuthStore } from '~/stores/useAuthStore'
import { canSubmitVisitIn, resolveTargetPoint } from '~/pages/app/visits/visit-in'
import GeofenceRadar from '~/components/map/GeofenceRadar.vue'

definePageMeta({
  layout: 'default'
})

const VISIT_IN_MUTATION: MutationType = 'VISIT_IN'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const geofence = useGeofence()
const antiSpoof = useAntiSpoof()
const visits = useVisits()
const db = useOfflineDb()
const api = useApiClient()
const toast = useToast()

const planId = computed(() => String(route.params.id))
const plan = ref<VisitPlan | null>(null)
const customer = ref<MasterCustomer | null>(null)
const loading = ref(true)
const currentFix = ref<EvaluatedPosition | null>(null)
const submitting = ref(false)
let geoWatchId: number | null = null

/** True once a trustworthy GPS fix has been captured (passes the anti-spoof accuracy window). */
const hasValidFix = computed(() =>
  currentFix.value !== null && antiSpoof.lastResult.value?.ok === true
)

/** Whether the visit-in submit is allowed (valid fix, inside radius, not already submitting). */
const canSubmit = computed(() =>
  canSubmitVisitIn({
    hasValidFix: hasValidFix.value,
    isWithinRadius: geofence.isWithinRadius.value,
    submitting: submitting.value
  })
)

/** Feed a browser Geolocation fix into geofence + anti-spoof state. */
function ingestPosition(coords: GeolocationCoordinates): void {
  const fix: EvaluatedPosition = {
    lat: coords.latitude,
    lng: coords.longitude,
    accuracy: coords.accuracy,
    mocked: (coords as GeolocationCoordinates & { mocked?: boolean }).mocked
  }
  currentFix.value = fix
  geofence.updatePosition({ lat: fix.lat, lng: fix.lng })
  antiSpoof.evaluatePosition(fix)
}

/** Start watching the device location (runtime only; guarded for SSR). */
function startLocationWatch(): void {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return
  geoWatchId = navigator.geolocation.watchPosition(
    position => ingestPosition(position.coords),
    () => {
      // Location denied/unavailable — leave the geofence readout in its pending state.
    },
    { enableHighAccuracy: true, maximumAge: 5_000, timeout: 15_000 }
  )
}

function stopLocationWatch(): void {
  if (geoWatchId !== null && typeof navigator !== 'undefined' && navigator.geolocation) {
    navigator.geolocation.clearWatch(geoWatchId)
  }
  geoWatchId = null
}

/** Resolve today's plan by route id and set the geofence target from its customer. */
async function loadPlan(): Promise<void> {
  loading.value = true
  await visits.load()
  const match = visits.items.value.find(item => item.plan.id === planId.value)
  plan.value = match?.plan ?? null
  if (plan.value) {
    customer.value = (await db.getCustomer(plan.value.company_id, plan.value.customer_id)) ?? null
    geofence.setTarget(resolveTargetPoint(customer.value))
  }
  loading.value = false
}

/** Surface an anti-spoof soft rejection to the user without banning them. */
function notifySpoofRejection(message: string): void {
  toast.add({
    title: 'Verifikasi lokasi gagal',
    description: message,
    color: 'warning',
    icon: 'i-lucide-shield-alert'
  })
}

/** Re-run anti-spoof Layer 1 + Layer 2 at submit time; returns true when both pass. */
function passesAntiSpoof(fix: EvaluatedPosition): boolean {
  const positionCheck = antiSpoof.evaluatePosition(fix)
  if (!positionCheck.ok) {
    notifySpoofRejection(positionCheck.message)
    return false
  }
  const clockCheck = antiSpoof.validateClock()
  if (!clockCheck.ok) {
    notifySpoofRejection(clockCheck.message)
    return false
  }
  return true
}

/** Notify the queued-vs-online outcome, then navigate into the in-visit hub. */
function completeVisitIn(result: VisitPlan | QueuedMutationResult): void {
  const queued = (result as QueuedMutationResult).queued === true
  toast.add({
    title: queued ? 'Kunjungan dimulai (offline)' : 'Kunjungan dimulai',
    description: queued
      ? 'Data akan disinkronkan otomatis saat koneksi kembali.'
      : 'Anda telah check-in pada lokasi kunjungan.',
    color: queued ? 'warning' : 'success',
    icon: queued ? 'i-lucide-cloud-off' : 'i-lucide-circle-check'
  })
  void router.push(`/app/visits/${planId.value}/in-visit`)
}

/** Record the visit-in: gate on radius + anti-spoof, then post/queue with customer_id. */
async function submitVisitIn(): Promise<void> {
  const fix = currentFix.value
  const activePlan = plan.value
  const role = auth.role
  if (!fix || !activePlan || !role) return
  if (!geofence.isWithinRadius.value) {
    notifySpoofRejection('Anda berada di luar radius geofence. Mendekatlah ke lokasi target.')
    return
  }
  if (!passesAntiSpoof(fix)) return

  submitting.value = true
  try {
    const result = await api.post<VisitPlan>('/visits/start', {
      identity: { company_id: activePlan.company_id, user_id: activePlan.user_id, user_role: role },
      mutationType: VISIT_IN_MUTATION,
      monoDeltaMs: typeof performance !== 'undefined' ? performance.now() : 0,
      body: {
        visit_plan_id: activePlan.id,
        customer_id: activePlan.customer_id,
        latitude: fix.lat,
        longitude: fix.lng,
        accuracy: fix.accuracy,
        distance_meters: geofence.distanceMeters.value,
        client_timestamp: new Date().toISOString()
      }
    })
    stopLocationWatch()
    completeVisitIn(result)
  } catch {
    toast.add({
      title: 'Gagal memulai kunjungan',
      description: 'Terjadi kesalahan. Silakan coba lagi.',
      color: 'error',
      icon: 'i-lucide-circle-alert'
    })
  } finally {
    submitting.value = false
  }
}

onMounted(async () => {
  antiSpoof.anchor()
  startLocationWatch()
  await loadPlan()
})

onUnmounted(() => {
  stopLocationWatch()
})
</script>

<template>
  <UContainer class="flex flex-col gap-5 py-5">
    <div class="flex flex-col gap-1">
      <h1 class="text-xl font-semibold text-primary">
        Mulai Kunjungan
      </h1>
      <p class="text-sm text-muted">
        Pastikan Anda berada dalam radius lokasi target sebelum memulai kunjungan.
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
      <!-- Target summary. -->
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

      <!-- Geofence radar (client-only: Leaflet touches window). -->
      <UCard>
        <template #header>
          <div class="flex items-center gap-2">
            <UIcon
              name="i-lucide-radar"
              class="size-5 text-primary"
            />
            <h2 class="text-sm font-semibold text-highlighted">
              Radar Geofence
            </h2>
          </div>
        </template>

        <ClientOnly>
          <GeofenceRadar
            :target="geofence.target.value"
            :position="geofence.position.value"
            :radius-meters="geofence.radiusMeters"
            :distance-meters="geofence.distanceMeters.value"
            :is-within-radius="geofence.isWithinRadius.value"
            :proximity-ratio="geofence.proximityRatio.value"
          />
          <template #fallback>
            <USkeleton class="h-64 w-full rounded-lg" />
          </template>
        </ClientOnly>

        <!-- Anti-spoof soft-rejection notice. -->
        <UAlert
          v-if="antiSpoof.lastResult.value && !antiSpoof.lastResult.value.ok"
          class="mt-3"
          icon="i-lucide-shield-alert"
          color="warning"
          variant="subtle"
          title="Verifikasi lokasi"
          :description="antiSpoof.lastResult.value.message"
        />
      </UCard>

      <!-- Submit — gated to within-radius + trustworthy fix. -->
      <UButton
        block
        size="lg"
        icon="i-lucide-door-open"
        :loading="submitting"
        :disabled="!canSubmit"
        @click="submitVisitIn"
      >
        Visit In
      </UButton>

      <p
        v-if="!geofence.isWithinRadius.value && geofence.distanceMeters.value !== null"
        class="text-center text-xs text-warning"
      >
        Anda di luar radius geofence — dekati lokasi target untuk memulai kunjungan.
      </p>
    </template>
  </UContainer>
</template>
