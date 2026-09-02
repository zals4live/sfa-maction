/**
 * `useSignatureCapture` — canvas-to-PNG export + S3 pre-signed signature upload for the PWA.
 *
 * Powers the visit-out (visit completion) digital-signature step for both field roles
 * (SALESMAN & MR). It owns the "encode → upload" half of the flow while keeping binary data
 * OUT of the API server, mirroring `useSelfieCapture`:
 *  - Encode: turn a caller-supplied signature `<canvas>` into a PNG `Blob` + object-URL
 *    preview (the stroke tracking itself lives in the SFC + the pure `signature-pad.ts`).
 *  - Upload: request a short-lived pre-signed PUT URL from
 *    `POST /visits/:id/signature-upload-url` (via the injected token-bearing transport),
 *    then `PUT` the PNG bytes DIRECTLY to S3. The API server only ever sees the returned
 *    `s3_key`, which the visit-out call attaches as `signature_s3_key`.
 *
 * The transport and uploader seams are injectable so the composable is unit testable without
 * a real network; runtime falls back to Nuxt `$fetch` and `fetch`.
 */
import { onUnmounted, readonly, ref, type Ref } from 'vue'
import { AUTH_TOKEN_STORAGE_KEY } from './useApiClient'

/** MIME type the backend accepts for a signature upload (`SignatureUploadUrlBody`). */
export type SignatureMimeType = 'image/png'

/** An encoded signature: the raw PNG bytes plus an object-URL preview for the UI. */
export interface EncodedSignature {
  blob: Blob
  previewUrl: string
  contentType: SignatureMimeType
}

/** Backend envelope for `POST /visits/:id/signature-upload-url`. */
interface SignatureUploadUrlEnvelope {
  data: {
    upload_url: string
    s3_key: string
    expires_in: number
  }
}

/** Token-bearing transport for the pre-signed URL request (online-only, never queued). */
export type SignatureUploadUrlTransport = (
  visitId: string,
  body: { content_type: SignatureMimeType }
) => Promise<SignatureUploadUrlEnvelope>

/** Raw binary uploader that PUTs bytes to a pre-signed S3 URL. */
export type SignatureS3Uploader = (
  uploadUrl: string,
  blob: Blob,
  contentType: SignatureMimeType
) => Promise<void>

/** Options for {@link useSignatureCapture}; all optional so runtime and tests can diverge. */
export interface SignatureCaptureOptions {
  /** Override the pre-signed URL transport (defaults to a `$fetch`-backed, token-bearing call). */
  requestUploadUrl?: SignatureUploadUrlTransport
  /** Override the raw S3 uploader (defaults to `fetch` PUT). */
  uploadToS3?: SignatureS3Uploader
}

/** Public surface returned by {@link useSignatureCapture}. */
export interface SignatureCaptureApi {
  /** The most recently encoded signature, or `null` before encode / after reset. */
  encoded: Readonly<Ref<EncodedSignature | null>>
  /** Whether an upload is in flight. */
  isUploading: Readonly<Ref<boolean>>
  /** A user-facing error message from the last encode/upload failure, or `null`. */
  error: Readonly<Ref<string | null>>
  /** Encode the given canvas into {@link encoded} as a PNG; resolves the encoded blob. */
  encode: (canvas: HTMLCanvasElement) => Promise<EncodedSignature | null>
  /** Discard the encoded signature (revoking its preview URL) so the user can redraw. */
  reset: () => void
  /** Upload the encoded PNG via a pre-signed URL and resolve the stored `s3_key`. */
  upload: (visitId: string) => Promise<string>
}

/** The only signature content type the backend accepts. */
const SIGNATURE_MIME: SignatureMimeType = 'image/png'

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
  visitId: string,
  body: { content_type: SignatureMimeType }
): Promise<SignatureUploadUrlEnvelope> {
  const token = readToken()
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const base = resolveBaseUrl().replace(/\/+$/, '')
  const url = `${base}/visits/${visitId}/signature-upload-url`
  const fetcher = ($fetch as unknown) as (u: string, o: unknown) => Promise<SignatureUploadUrlEnvelope>
  return fetcher(url, { method: 'POST', body, headers })
}

/** Default S3 uploader: PUT the raw PNG bytes to the pre-signed URL (bypasses the API server). */
async function defaultUploadToS3(
  uploadUrl: string,
  blob: Blob,
  contentType: SignatureMimeType
): Promise<void> {
  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: blob
  })
  if (!response.ok) throw new Error(`S3 upload failed with status ${response.status}`)
}

/** Encode a canvas to a PNG blob, resolving `null` when encoding is unsupported. */
function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    if (typeof canvas.toBlob !== 'function') {
      resolve(null)
      return
    }
    canvas.toBlob(blob => resolve(blob), SIGNATURE_MIME)
  })
}

export function useSignatureCapture(options: SignatureCaptureOptions = {}): SignatureCaptureApi {
  const requestUploadUrl = options.requestUploadUrl ?? defaultRequestUploadUrl
  const uploadToS3 = options.uploadToS3 ?? defaultUploadToS3

  const encoded = ref<EncodedSignature | null>(null)
  const isUploading = ref<boolean>(false)
  const error = ref<string | null>(null)

  /** Revoke an encoded preview URL to avoid leaking object URLs across redraws. */
  function revokePreview(): void {
    if (encoded.value?.previewUrl && typeof URL !== 'undefined') {
      URL.revokeObjectURL(encoded.value.previewUrl)
    }
  }

  async function encode(canvas: HTMLCanvasElement): Promise<EncodedSignature | null> {
    error.value = null
    const blob = await canvasToPngBlob(canvas)
    if (!blob) {
      error.value = 'Gagal menyimpan tanda tangan.'
      return null
    }
    revokePreview()
    const signature: EncodedSignature = {
      blob,
      previewUrl: typeof URL !== 'undefined' ? URL.createObjectURL(blob) : '',
      contentType: SIGNATURE_MIME
    }
    encoded.value = signature
    return signature
  }

  function reset(): void {
    revokePreview()
    encoded.value = null
    error.value = null
  }

  async function upload(visitId: string): Promise<string> {
    const signature = encoded.value
    if (!signature) throw new Error('Tidak ada tanda tangan untuk diunggah.')
    isUploading.value = true
    error.value = null
    try {
      const { data } = await requestUploadUrl(visitId, { content_type: signature.contentType })
      await uploadToS3(data.upload_url, signature.blob, signature.contentType)
      return data.s3_key
    } catch (err) {
      error.value = 'Gagal mengunggah tanda tangan. Periksa koneksi Anda.'
      throw err instanceof Error ? err : new Error('Signature upload failed.')
    } finally {
      isUploading.value = false
    }
  }

  // Release any preview URL when the owning component unmounts.
  onUnmounted(() => {
    revokePreview()
  })

  return {
    encoded: readonly(encoded) as Readonly<Ref<EncodedSignature | null>>,
    isUploading: readonly(isUploading) as Readonly<Ref<boolean>>,
    error: readonly(error) as Readonly<Ref<string | null>>,
    encode,
    reset,
    upload
  }
}
