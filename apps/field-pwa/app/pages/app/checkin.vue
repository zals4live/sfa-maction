<script setup lang="ts">
// Daily attendance check-in for BOTH field roles (SALESMAN & MR). The page orchestrates the
// three-step check-in flow while delegating all logic to composables (thin-page rule):
//   1. Category   — pick the attendance type (Office / Customer / Other) via URadioGroup.
//   2. Selfie     — capture a photo with the device camera and upload it to S3 via a
//                   pre-signed URL (`useSelfieCapture`); binary never touches the API server.
//   3. Geofence   — show live GPS readiness (accuracy) + proximity, gated by anti-spoof
//                   (`useAntiSpoof` mock/accuracy + monotonic-clock) and `useGeofence`.
// Submission flows through `useAttendanceStore.checkIn`, which posts online or queues to the
// offline outbox — a queued result still unlocks visit features optimistically.
// Forced light mode (no dark: variants).
import { computed, onMounted, onUnmounted, ref, useTemplateRef } from 'vue'
import { AttendanceType } from '@maction/types'
import { useAttendanceStore } from '~/stores/useAttendanceStore'
import { useGeofence } from '~/composables/useGeofence'
import { useAntiSpoof, type EvaluatedPosition } from '~/composables/useAntiSpoof'
import { useSelfieCapture } from '~/composables/useSelfieCapture'
import type { QueuedMutationResult } from '~/composables/useApiClient'

definePageMeta({
  layout: 'default'
})

const attendance = useAttendanceStore()
const geofence = useGeofence()
const antiSpoof = useAntiSpoof()
const selfie = useSelfieCapture({ facingMode: 'user' })
const toast = useToast()

const videoRef = useTemplateRef<HTMLVideoElement>('video')

// --- Attendance category (URadioGroup, card variant) ---------------------------------------
const attendanceType = ref<AttendanceType>(AttendanceType.OFFICE)
const categoryItems = [
  { value: AttendanceType.OFFICE, label: 'Kantor', description: 'Absen di kantor cabang', icon: 'i-lucide-building-2' },
  { value: AttendanceType.CUSTOMER, label: 'Pelanggan', description: 'Absen di lokasi pelanggan', icon: 'i-lucide-store' },
  { value: AttendanceType.OTHER, label: 'Lainnya', description: 'Lokasi kerja lain', icon: 'i-lucide-map-pin' }
]

// --- Live GPS + anti-spoof state -----------------------------------------------------------
/** Latest raw GPS fix (used for anti-spoof accuracy/mock evaluation). */
const currentFix = ref<EvaluatedPosition | null>(null)
const submitting = ref(false)
let geoWatchId: number | null = null

/** True once a trustworthy GPS fix has been captured (passes the anti-spoof accuracy window). */
const hasValidFix = computed(() => {
  const fix = currentFix.value
  return fix !== null && antiSpoof.lastResult.value?.ok === true
})

/** Human-readable geofence distance label (server validates authoritatively on submit). */
const distanceLabel = computed(() => {
  const distance = geofence.distanceMeters.value
  if (distance === null) return 'Menghitung jarak...'
  return `${Math.round(distance)} m dari lokasi target`
})

/** Whether all preconditions for submitting a check-in are met. */
const canSubmit = computed(() =>
  !attendance.hasCheckedIn
  && hasValidFix.value
  && selfie.captured.value !== null
  && !submitting.value
)

/** Feed a browser Geolocation position into geofence + anti-spoof state. */
function ingestPosition(coords: GeolocationCoordinates): void {
  const fix: EvaluatedPosition = {
    lat: coords.latitude,
    lng: coords.longitude,
    accuracy: coords.accuracy,
    // Some Android/WebView builds surface an OS mock flag on the position; forward it when present.
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

// --- Selfie camera controls ----------------------------------------------------------------
async function openCamera(): Promise<void> {
  if (videoRef.value) await selfie.start(videoRef.value)
}

async function takePhoto(): Promise<void> {
  if (videoRef.value) await selfie.capture(videoRef.value)
}

function retakePhoto(): void {
  selfie.retake()
  void openCamera()
}

// --- Submit --------------------------------------------------------------------------------
/** Surface an anti-spoof soft rejection to the user without banning them. */
function notifySpoofRejection(message: string): void {
  toast.add({
    title: 'Verifikasi lokasi gagal',
    description: message,
    color: 'warning',
    icon: 'i-lucide-shield-alert'
  })
}

/** Run the full check-in: re-validate anti-spoof, upload the selfie, then post/queue. */
async function submitCheckIn(): Promise<void> {
  const fix = currentFix.value
  if (!fix) return

  // Re-evaluate the fix at submit time (Layer 1) — soft reject on mock/accuracy failure.
  const positionCheck = antiSpoof.evaluatePosition(fix)
  if (!positionCheck.ok) {
    notifySpoofRejection(positionCheck.message)
    return
  }
  // Layer 2: validate the monotonic clock against the anchor set on mount.
  const clockCheck = antiSpoof.validateClock()
  if (!clockCheck.ok) {
    notifySpoofRejection(clockCheck.message)
    return
  }

  submitting.value = true
  try {
    const photoS3Key = await selfie.upload('check_in')
    const nowMs = Date.now()
    const result = await attendance.checkIn({
      attendance_type: attendanceType.value,
      latitude: fix.lat,
      longitude: fix.lng,
      accuracy: fix.accuracy,
      photo_s3_key: photoS3Key,
      monotonic_delta_ms: typeof performance !== 'undefined' ? performance.now() : 0,
      client_timestamp: new Date(nowMs).toISOString()
    })

    selfie.stop()
    stopLocationWatch()

    if ((result as QueuedMutationResult).queued === true) {
      toast.add({
        title: 'Absen tersimpan (offline)',
        description: 'Absen akan disinkronkan otomatis saat koneksi kembali.',
        color: 'warning',
        icon: 'i-lucide-cloud-off'
      })
    } else {
      toast.add({
        title: 'Absen berhasil',
        description: 'Anda telah melakukan check-in hari ini.',
        color: 'success',
        icon: 'i-lucide-circle-check'
      })
    }
  } catch {
    toast.add({
      title: 'Gagal absen',
      description: 'Terjadi kesalahan. Silakan coba lagi.',
      color: 'error',
      icon: 'i-lucide-circle-alert'
    })
  } finally {
    submitting.value = false
  }
}

onMounted(async () => {
  // Anchor the monotonic clock baseline immediately for later drift validation.
  antiSpoof.anchor()
  startLocationWatch()
  // Load today's record so an already-checked-in state is reflected on entry.
  await attendance.fetchToday()
})

onUnmounted(() => {
  stopLocationWatch()
  selfie.stop()
})
</script>

<template>
  <UContainer class="flex flex-col gap-5 py-5">
    <div class="flex flex-col gap-1">
      <h1 class="text-xl font-semibold text-primary">
        Absensi Harian
      </h1>
      <p class="text-sm text-muted">
        Lakukan check-in untuk memulai aktivitas lapangan Anda.
      </p>
    </div>

    <!-- Already checked in today -->
    <UAlert
      v-if="attendance.hasCheckedIn"
      icon="i-lucide-circle-check"
      color="success"
      variant="subtle"
      title="Sudah absen hari ini"
      :description="attendance.isCheckInPending
        ? 'Absen Anda menunggu sinkronisasi ke server.'
        : 'Anda sudah melakukan check-in untuk hari ini.'"
    />

    <template v-else>
      <!-- Step 1: Attendance category -->
      <UCard>
        <template #header>
          <div class="flex items-center gap-2">
            <UIcon
              name="i-lucide-list-checks"
              class="size-5 text-primary"
            />
            <h2 class="text-sm font-semibold text-highlighted">
              Kategori Kehadiran
            </h2>
          </div>
        </template>

        <URadioGroup
          v-model="attendanceType"
          :items="categoryItems"
          variant="card"
          color="primary"
        />
      </UCard>

      <!-- Step 2: Selfie capture -->
      <UCard>
        <template #header>
          <div class="flex items-center gap-2">
            <UIcon
              name="i-lucide-camera"
              class="size-5 text-primary"
            />
            <h2 class="text-sm font-semibold text-highlighted">
              Foto Selfie
            </h2>
          </div>
        </template>

        <div class="flex flex-col gap-3">
          <div class="relative aspect-3/4 w-full overflow-hidden rounded-lg bg-elevated">
            <!-- Captured preview -->
            <img
              v-if="selfie.captured.value"
              :src="selfie.captured.value.previewUrl"
              alt="Pratinjau foto selfie"
              class="size-full object-cover"
            >
            <!-- Live camera stream -->
            <video
              v-show="!selfie.captured.value && selfie.isCameraActive.value"
              ref="video"
              class="size-full object-cover"
              autoplay
              playsinline
              muted
            />
            <!-- Idle placeholder -->
            <div
              v-if="!selfie.captured.value && !selfie.isCameraActive.value"
              class="flex size-full flex-col items-center justify-center gap-2 text-muted"
            >
              <UIcon
                name="i-lucide-camera-off"
                class="size-10"
              />
              <span class="text-xs">Kamera belum aktif</span>
            </div>
          </div>

          <p
            v-if="selfie.error.value"
            class="text-xs text-error"
          >
            {{ selfie.error.value }}
          </p>

          <div class="flex flex-wrap gap-2">
            <UButton
              v-if="!selfie.isCameraActive.value && !selfie.captured.value"
              icon="i-lucide-camera"
              color="primary"
              @click="openCamera"
            >
              Aktifkan Kamera
            </UButton>
            <UButton
              v-if="selfie.isCameraActive.value && !selfie.captured.value"
              icon="i-lucide-aperture"
              color="primary"
              @click="takePhoto"
            >
              Ambil Foto
            </UButton>
            <UButton
              v-if="selfie.captured.value"
              icon="i-lucide-rotate-ccw"
              color="neutral"
              variant="outline"
              @click="retakePhoto"
            >
              Ambil Ulang
            </UButton>
          </div>
        </div>
      </UCard>

      <!-- Step 3: Geofence + GPS readiness -->
      <UCard>
        <template #header>
          <div class="flex items-center gap-2">
            <UIcon
              name="i-lucide-locate-fixed"
              class="size-5 text-primary"
            />
            <h2 class="text-sm font-semibold text-highlighted">
              Lokasi & Geofence
            </h2>
          </div>
        </template>

        <div class="flex flex-col gap-3">
          <div class="flex items-center justify-between gap-2">
            <span class="text-sm text-muted">Status GPS</span>
            <UBadge
              :color="hasValidFix ? 'success' : 'warning'"
              variant="subtle"
              :icon="hasValidFix ? 'i-lucide-satellite-dish' : 'i-lucide-loader'"
            >
              {{ hasValidFix ? 'Sinyal valid' : 'Menunggu sinyal' }}
            </UBadge>
          </div>

          <div class="flex items-center justify-between gap-2">
            <span class="text-sm text-muted">Akurasi</span>
            <span class="text-sm font-medium text-highlighted">
              {{ currentFix ? `${Math.round(currentFix.accuracy)} m` : '—' }}
            </span>
          </div>

          <div class="flex items-center justify-between gap-2">
            <span class="text-sm text-muted">Jarak</span>
            <span class="text-sm font-medium text-highlighted">
              {{ distanceLabel }}
            </span>
          </div>

          <div
            v-if="geofence.distanceMeters.value !== null"
            class="flex items-center gap-2"
          >
            <UIcon
              :name="geofence.isWithinRadius.value ? 'i-lucide-circle-check' : 'i-lucide-circle-alert'"
              :class="geofence.isWithinRadius.value ? 'size-4 text-success' : 'size-4 text-warning'"
            />
            <span
              class="text-xs"
              :class="geofence.isWithinRadius.value ? 'text-success' : 'text-warning'"
            >
              {{ geofence.isWithinRadius.value
                ? 'Anda berada dalam radius geofence.'
                : 'Anda di luar radius geofence — akan ditandai untuk ditinjau.' }}
            </span>
          </div>

          <UAlert
            v-if="antiSpoof.lastResult.value && !antiSpoof.lastResult.value.ok"
            icon="i-lucide-shield-alert"
            color="warning"
            variant="subtle"
            title="Verifikasi lokasi"
            :description="antiSpoof.lastResult.value.message"
          />
        </div>
      </UCard>

      <!-- Submit -->
      <UButton
        block
        size="lg"
        icon="i-lucide-fingerprint"
        :loading="submitting || selfie.isUploading.value"
        :disabled="!canSubmit"
        @click="submitCheckIn"
      >
        Check-In Sekarang
      </UButton>
    </template>
  </UContainer>
</template>
