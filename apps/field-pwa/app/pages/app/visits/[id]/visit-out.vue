<script setup lang="ts">
// Visit-out (visit completion) flow for a single planned visit (SALESMAN & MR). This is the
// final step of the in-visit workflow: the field user captures a customer/PIC digital
// signature, a trustworthy GPS fix, and a monotonic timestamp, then records the visit-out.
// The page is intentionally THIN — all logic lives in composables and the pure `visit-out.ts`
// helper, mirroring the sibling `visit-in.vue`:
//   - `useVisits` resolves today's plan by route id (offline-first).
//   - `useOfflineDb.getCustomer` yields the target's name/address for the summary header.
//   - `SignaturePad` + `useSignatureCapture` encode the signature to PNG and upload it DIRECTLY
//     to S3 via a pre-signed URL (`POST /visits/:id/signature-upload-url`); only the returned
//     `s3_key` reaches the API server, attached below as `signature_s3_key`.
//   - `useAntiSpoof` runs Layer 1 (mock/accuracy) + Layer 2 (monotonic clock) checks and owns
//     the `performance.now()` monotonic baseline anchored on mount.
//   - `useApiClient.post('/visits/:id/end', ...)` records the visit-out online, falling back to
//     the offline outbox (VISIT_OUT) so completion works with no network. The payload carries
//     `customer_id` so `visit-status.ts` can derive COMPLETED from the queued mutation.
// Visit-out is role-agnostic — it is NOT gated by role. Anti-spoof failures are SOFT-rejected
// (blocked, non-aggressive toast) — never a ban. Forced light mode (no dark: variants).
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { MasterCustomer, MutationType, VisitPlan } from '@maction/types'
import { useAntiSpoof, type EvaluatedPosition } from '~/composables/useAntiSpoof'
import { useVisits } from '~/composables/useVisits'
import { useOfflineDb } from '~/composables/useOfflineDb'
import { useApiClient, type QueuedMutationResult } from '~/composables/useApiClient'
import { useAuthStore } from '~/stores/useAuthStore'
import { canSubmitVisitOut } from '~/pages/app/visits/visit-out'
import SignaturePad from '~/components/signature/SignaturePad.vue'

definePageMeta({
  layout: 'default'
})

const VISIT_OUT_MUTATION: MutationType = 'VISIT_OUT'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
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
const signatureKey = ref<string | null>(null)
const submitting = ref(false)
let geoWatchId: number | null = null

/** True once a trustworthy GPS fix has been captured (passes the anti-spoof accuracy window). */
const hasValidFix = computed(() =>
  currentFix.value !== null && antiSpoof.lastResult.value?.ok === true
)

/** Whether the visit-out submit is allowed (signature captured, valid fix, not submitting). */
const canSubmit = computed(() =>
  canSubmitVisitOut({
    hasSignature: signatureKey.value !== null,
    hasValidFix: hasValidFix.value,
    submitting: submitting.value
  })
)

/** Feed a browser Geolocation fix into anti-spoof state. */
function ingestPosition(coords: GeolocationCoordinates): void {
  const fix: EvaluatedPosition = {
    lat: coords.latitude,
    lng: coords.longitude,
    accuracy: coords.accuracy,
    mocked: (coords as GeolocationCoordinates & { mocked?: boolean }).mocked
  }
  currentFix.value = fix
  antiSpoof.evaluatePosition(fix)
}

/** Start watching the device location (runtime only; guarded for SSR). */
function startLocationWatch(): void {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return
  geoWatchId = navigator.geolocation.watchPosition(
    position => ingestPosition(position.coords),
    () => {
      // Location denied/unavailable — leave the fix in its pending state.
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

/** Record the captured signature's S3 key once `SignaturePad` finishes its upload. */
function onSignatureSaved(s3Key: string): void {
  signatureKey.value = s3Key
}

/** Resolve today's plan by route id and load its customer for the summary header. */
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

/** Notify the queued-vs-online outcome, then navigate back to the visit list. */
function completeVisitOut(result: VisitPlan | QueuedMutationResult): void {
  const queued = (result as QueuedMutationResult).queued === true
  toast.add({
    title: queued ? 'Kunjungan selesai (offline)' : 'Kunjungan selesai',
    description: queued
      ? 'Data akan disinkronkan otomatis saat koneksi kembali.'
      : 'Kunjungan telah ditutup dengan tanda tangan.',
    color: queued ? 'warning' : 'success',
    icon: queued ? 'i-lucide-cloud-off' : 'i-lucide-circle-check'
  })
  void router.push('/app/visits')
}

/** Complete the visit: gate on anti-spoof, then post/queue with customer_id + signature. */
async function submitVisitOut(): Promise<void> {
  const fix = currentFix.value
  const activePlan = plan.value
  const role = auth.role
  const s3Key = signatureKey.value
  if (!fix || !activePlan || !role || !s3Key) return
  if (!passesAntiSpoof(fix)) return

  submitting.value = true
  const monoDeltaMs = typeof performance !== 'undefined' ? performance.now() : 0
  try {
    const result = await api.post<VisitPlan>(`/visits/${planId.value}/end`, {
      identity: { company_id: activePlan.company_id, user_id: activePlan.user_id, user_role: role },
      mutationType: VISIT_OUT_MUTATION,
      monoDeltaMs,
      body: {
        customer_id: activePlan.customer_id,
        signature_s3_key: s3Key,
        latitude: fix.lat,
        longitude: fix.lng,
        accuracy: fix.accuracy,
        monotonic_delta_ms: monoDeltaMs,
        client_timestamp: new Date().toISOString()
      }
    })
    stopLocationWatch()
    completeVisitOut(result)
  } catch {
    toast.add({
      title: 'Gagal menyelesaikan kunjungan',
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
        Selesaikan Kunjungan
      </h1>
      <p class="text-sm text-muted">
        Bubuhkan tanda tangan pelanggan dan pastikan lokasi terverifikasi sebelum menutup kunjungan.
      </p>
    </div>

    <!-- Loading skeleton while the plan + customer resolve. -->
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
      <!-- Target customer summary. -->
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

      <!-- Digital signature capture (uploads to S3, emits the stored key). -->
      <UCard>
        <template #header>
          <div class="flex items-center gap-2">
            <UIcon
              name="i-lucide-pen-line"
              class="size-5 text-primary"
            />
            <h2 class="text-sm font-semibold text-highlighted">
              Tanda Tangan Pelanggan
            </h2>
          </div>
        </template>

        <SignaturePad
          :visit-id="planId"
          @saved="onSignatureSaved"
        />

        <UAlert
          v-if="signatureKey"
          class="mt-3"
          icon="i-lucide-circle-check"
          color="success"
          variant="subtle"
          title="Tanda tangan tersimpan"
          description="Tanda tangan berhasil diunggah dan siap dilampirkan."
        />
      </UCard>

      <!-- Anti-spoof soft-rejection notice. -->
      <UAlert
        v-if="antiSpoof.lastResult.value && !antiSpoof.lastResult.value.ok"
        icon="i-lucide-shield-alert"
        color="warning"
        variant="subtle"
        title="Verifikasi lokasi"
        :description="antiSpoof.lastResult.value.message"
      />

      <!-- Submit — gated to a captured signature + a trustworthy fix. -->
      <UButton
        block
        size="lg"
        icon="i-lucide-door-closed"
        :loading="submitting"
        :disabled="!canSubmit"
        @click="submitVisitOut"
      >
        Visit Out
      </UButton>

      <p
        v-if="!signatureKey"
        class="text-center text-xs text-muted"
      >
        Simpan tanda tangan pelanggan untuk mengaktifkan tombol selesai.
      </p>
      <p
        v-else-if="!hasValidFix"
        class="text-center text-xs text-warning"
      >
        Menunggu sinyal GPS yang terpercaya untuk memverifikasi lokasi.
      </p>
    </template>
  </UContainer>
</template>
