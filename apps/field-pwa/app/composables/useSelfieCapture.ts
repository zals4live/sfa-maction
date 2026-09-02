/**
 * `useSelfieCapture` — HTML5 camera capture + S3 pre-signed selfie upload for the Field PWA.
 *
 * Powers the check-in / check-out selfie step for both field roles (SALESMAN & MR). It owns
 * the full "capture → upload" lifecycle while keeping binary data OUT of the API server:
 *  - Camera lifecycle: open the device camera via `getUserMedia` (front-facing by default),
 *    bind the live stream to a caller-supplied `<video>` element, and release all tracks on
 *    `stop()` / unmount so the camera light never lingers.
 *  - Capture: draw the current video frame onto an offscreen `<canvas>` and encode it to a
 *    JPEG `Blob` + object-URL preview the page can show for confirm/retake.
 *  - Upload: request a short-lived pre-signed PUT URL from `POST /attendance/upload-url`
 *    (via the injected token-bearing transport), then `PUT` the JPEG bytes DIRECTLY to S3.
 *    The API server only ever sees the returned `s3_key`, never the image bytes.
 *
 * The camera, transport, and uploader seams are all injectable so the composable is unit
 * testable without a real device camera or network; runtime falls back to the browser
 * `navigator.mediaDevices`, Nuxt `$fetch`, and `fetch`.
 */
import { onUnmounted, readonly, ref, type Ref } from 'vue'
import { AUTH_TOKEN_STORAGE_KEY } from './useApiClient'

/** MIME types the backend accepts for a selfie upload (mirrors `UploadUrlBody`). */
export type SelfieMimeType = 'image/jpeg' | 'image/png' | 'image/webp'

/** Upload purpose forwarded to the pre-signed URL request. */
export type SelfiePurpose = 'check_in' | 'check_out'

/** A captured still frame: the raw JPEG bytes plus an object-URL preview for the UI. */
export interface CapturedPhoto {
  blob: Blob
  previewUrl: string
  contentType: SelfieMimeType
}

/** Backend envelope for `POST /attendance/upload-url`. */
interface UploadUrlEnvelope {
  data: {
    upload_url: string
    s3_key: string
    expires_in: number
  }
}

/** Minimal camera seam — satisfied by `navigator.mediaDevices` or a test fake. */
export type CameraSeam = (constraints: MediaStreamConstraints) => Promise<MediaStream>

/** Token-bearing transport for the pre-signed URL request (online-only, never queued). */
export type UploadUrlTransport = (
  body: { content_type: SelfieMimeType, purpose: SelfiePurpose }
) => Promise<UploadUrlEnvelope>

/** Raw binary uploader that PUTs bytes to a pre-signed S3 URL. */
export type S3Uploader = (uploadUrl: string, blob: Blob, contentType: SelfieMimeType) => Promise<void>

/** Options for {@link useSelfieCapture}; all optional so runtime and tests can diverge. */
export interface SelfieCaptureOptions {
  /** Override the camera provider (tests inject a fake stream; runtime uses `getUserMedia`). */
  camera?: CameraSeam
  /** Override the pre-signed URL transport (defaults to a `$fetch`-backed, token-bearing call). */
  requestUploadUrl?: UploadUrlTransport
  /** Override the raw S3 uploader (defaults to `fetch` PUT). */
  uploadToS3?: S3Uploader
  /** Facing mode for the capture camera; defaults to the front (`'user'`) camera for selfies. */
  facingMode?: 'user' | 'environment'
  /** JPEG encode quality (0..1); defaults to 0.85 to keep uploads under the 10MB S3 cap. */
  quality?: number
}

/** Public surface returned by {@link useSelfieCapture}. */
export interface SelfieCaptureApi {
  /** Whether the live camera stream is currently active. */
  isCameraActive: Readonly<Ref<boolean>>
  /** The most recently captured photo, or `null` before/after a retake. */
  captured: Readonly<Ref<CapturedPhoto | null>>
  /** Whether an upload is in flight. */
  isUploading: Readonly<Ref<boolean>>
  /** A user-facing error message from the last camera/upload failure, or `null`. */
  error: Readonly<Ref<string | null>>
  /** Open the camera and bind its stream to the given `<video>` element. */
  start: (video: HTMLVideoElement) => Promise<void>
  /** Stop the camera and release all media tracks. */
  stop: () => void
  /** Capture the current video frame into {@link captured} as a JPEG. */
  capture: (video: HTMLVideoElement) => Promise<CapturedPhoto | null>
  /** Discard the captured photo (revoking its preview URL) so the user can retake. */
  retake: () => void
  /** Upload the captured JPEG via a pre-signed URL and resolve the stored `s3_key`. */
  upload: (purpose: SelfiePurpose) => Promise<string>
}

/** Default JPEG content type for captured selfies. */
const DEFAULT_MIME: SelfieMimeType = 'image/jpeg'

/** Resolve the runtime camera provider, or `null` where the API is unavailable. */
function resolveCamera(camera?: CameraSeam): CameraSeam | null {
  if (camera) return camera
  const media = (globalThis as { navigator?: { mediaDevices?: MediaDevices } }).navigator?.mediaDevices
  if (!media || typeof media.getUserMedia !== 'function') return null
  return constraints => media.getUserMedia(constraints)
}

/** Resolve the API base URL from Nuxt runtimeConfig, degrading gracefully off-Nuxt. */
function resolveBaseUrl(): string {
  const hook = (globalThis as { useRuntimeConfig?: () => { public?: { apiBase?: string } } }).useRuntimeConfig
  try {
    const configured = typeof hook === 'function' ? hook()?.public?.apiBase : undefined
    return typeof configured === 'string' && configured.length > 0 ? configured : '/api'
  } catch {
    return '/api'
  }
}

/** Read the persisted opaque JWT so the pre-signed URL request is authenticated. */
function readToken(): string | null {
  if (typeof localStorage === 'undefined') return null
  return localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)
}

/** Default transport: request a pre-signed URL via `$fetch`, attaching the bearer token. */
function defaultRequestUploadUrl(
  body: { content_type: SelfieMimeType, purpose: SelfiePurpose }
): Promise<UploadUrlEnvelope> {
  const token = readToken()
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const url = `${resolveBaseUrl().replace(/\/+$/, '')}/attendance/upload-url`
  const fetcher = ($fetch as unknown) as (u: string, o: unknown) => Promise<UploadUrlEnvelope>
  return fetcher(url, { method: 'POST', body, headers })
}

/** Default S3 uploader: PUT the raw JPEG bytes to the pre-signed URL (bypasses the API server). */
async function defaultUploadToS3(uploadUrl: string, blob: Blob, contentType: SelfieMimeType): Promise<void> {
  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: blob
  })
  if (!response.ok) throw new Error(`S3 upload failed with status ${response.status}`)
}

export function useSelfieCapture(options: SelfieCaptureOptions = {}): SelfieCaptureApi {
  const camera = resolveCamera(options.camera)
  const requestUploadUrl = options.requestUploadUrl ?? defaultRequestUploadUrl
  const uploadToS3 = options.uploadToS3 ?? defaultUploadToS3
  const facingMode = options.facingMode ?? 'user'
  const quality = options.quality ?? 0.85

  const isCameraActive = ref(false)
  const captured = ref<CapturedPhoto | null>(null)
  const isUploading = ref(false)
  const error = ref<string | null>(null)

  let stream: MediaStream | null = null

  /** Revoke a captured preview URL to avoid leaking object URLs across retakes. */
  function revokePreview(): void {
    if (captured.value?.previewUrl && typeof URL !== 'undefined') {
      URL.revokeObjectURL(captured.value.previewUrl)
    }
  }

  async function start(video: HTMLVideoElement): Promise<void> {
    error.value = null
    if (!camera) {
      error.value = 'Kamera tidak tersedia di perangkat ini.'
      return
    }
    try {
      stream = await camera({ video: { facingMode }, audio: false })
      video.srcObject = stream
      await video.play().catch(() => undefined)
      isCameraActive.value = true
    } catch {
      error.value = 'Tidak dapat mengakses kamera. Mohon izinkan akses kamera.'
      isCameraActive.value = false
    }
  }

  function stop(): void {
    stream?.getTracks().forEach(track => track.stop())
    stream = null
    isCameraActive.value = false
  }

  /** Encode a canvas to a JPEG blob, resolving `null` when encoding is unsupported. */
  function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
    return new Promise((resolve) => {
      if (typeof canvas.toBlob !== 'function') {
        resolve(null)
        return
      }
      canvas.toBlob(blob => resolve(blob), DEFAULT_MIME, quality)
    })
  }

  async function capture(video: HTMLVideoElement): Promise<CapturedPhoto | null> {
    error.value = null
    const width = video.videoWidth
    const height = video.videoHeight
    if (!width || !height) {
      error.value = 'Kamera belum siap. Coba lagi sesaat.'
      return null
    }
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) {
      error.value = 'Gagal mengambil gambar.'
      return null
    }
    context.drawImage(video, 0, 0, width, height)
    const blob = await canvasToBlob(canvas)
    if (!blob) {
      error.value = 'Gagal menyimpan gambar.'
      return null
    }
    revokePreview()
    const photo: CapturedPhoto = {
      blob,
      previewUrl: typeof URL !== 'undefined' ? URL.createObjectURL(blob) : '',
      contentType: DEFAULT_MIME
    }
    captured.value = photo
    return photo
  }

  function retake(): void {
    revokePreview()
    captured.value = null
    error.value = null
  }

  async function upload(purpose: SelfiePurpose): Promise<string> {
    const photo = captured.value
    if (!photo) throw new Error('Tidak ada foto untuk diunggah.')
    isUploading.value = true
    error.value = null
    try {
      const { data } = await requestUploadUrl({ content_type: photo.contentType, purpose })
      await uploadToS3(data.upload_url, photo.blob, photo.contentType)
      return data.s3_key
    } catch (err) {
      error.value = 'Gagal mengunggah foto. Periksa koneksi Anda.'
      throw err instanceof Error ? err : new Error('Selfie upload failed.')
    } finally {
      isUploading.value = false
    }
  }

  // Release the camera and any preview URL when the owning component unmounts.
  onUnmounted(() => {
    stop()
    revokePreview()
  })

  return {
    isCameraActive: readonly(isCameraActive) as Readonly<Ref<boolean>>,
    captured: readonly(captured) as Readonly<Ref<CapturedPhoto | null>>,
    isUploading: readonly(isUploading) as Readonly<Ref<boolean>>,
    error: readonly(error) as Readonly<Ref<string | null>>,
    start,
    stop,
    capture,
    retake,
    upload
  }
}
