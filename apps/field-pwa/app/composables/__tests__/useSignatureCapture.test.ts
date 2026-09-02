import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSignatureCapture, type SignatureMimeType } from '../useSignatureCapture'

/**
 * A minimal fake canvas whose `toBlob` yields a fixed PNG blob, so the composable can be
 * exercised in the `node` Vitest environment without a real DOM canvas.
 */
function fakeCanvas(blob: Blob | null): HTMLCanvasElement {
  return {
    toBlob: (cb: (b: Blob | null) => void, _type?: string) => cb(blob)
  } as unknown as HTMLCanvasElement
}

/** A tiny stand-in PNG blob (contents irrelevant — only identity + type matter). */
function pngBlob(): Blob {
  return new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useSignatureCapture', () => {
  describe('encode', () => {
    it('should encode a canvas into a PNG signature', async () => {
      const capture = useSignatureCapture()
      const encoded = await capture.encode(fakeCanvas(pngBlob()))
      expect(encoded).not.toBeNull()
      expect(encoded?.contentType).toBe('image/png')
      expect(encoded?.blob.type).toBe('image/png')
      expect(capture.error.value).toBeNull()
    })

    it('should surface an error when the canvas cannot be encoded', async () => {
      const capture = useSignatureCapture()
      const encoded = await capture.encode(fakeCanvas(null))
      expect(encoded).toBeNull()
      expect(capture.error.value).not.toBeNull()
    })
  })

  describe('upload', () => {
    it('should request a visit-scoped pre-signed URL and PUT bytes to S3', async () => {
      const requestUploadUrl = vi.fn(async (_visitId: string, _body: { content_type: SignatureMimeType }) => ({
        data: { upload_url: 'https://s3.example/put', s3_key: 'company/visits/signatures/2025/sig.png', expires_in: 900 }
      }))
      const uploadToS3 = vi.fn(async () => undefined)

      const capture = useSignatureCapture({ requestUploadUrl, uploadToS3 })
      await capture.encode(fakeCanvas(pngBlob()))
      const s3Key = await capture.upload('visit-123')

      expect(requestUploadUrl).toHaveBeenCalledWith('visit-123', { content_type: 'image/png' })
      expect(uploadToS3).toHaveBeenCalledWith('https://s3.example/put', expect.any(Blob), 'image/png')
      expect(s3Key).toBe('company/visits/signatures/2025/sig.png')
      expect(capture.isUploading.value).toBe(false)
    })

    it('should throw when there is nothing encoded to upload', async () => {
      const capture = useSignatureCapture({
        requestUploadUrl: vi.fn(),
        uploadToS3: vi.fn()
      })
      await expect(capture.upload('visit-123')).rejects.toThrow()
    })

    it('should set an error and rethrow when the S3 PUT fails', async () => {
      const requestUploadUrl = vi.fn(async () => ({
        data: { upload_url: 'https://s3.example/put', s3_key: 'k', expires_in: 900 }
      }))
      const uploadToS3 = vi.fn(async () => {
        throw new Error('network down')
      })
      const capture = useSignatureCapture({ requestUploadUrl, uploadToS3 })
      await capture.encode(fakeCanvas(pngBlob()))
      await expect(capture.upload('visit-123')).rejects.toThrow()
      expect(capture.error.value).not.toBeNull()
      expect(capture.isUploading.value).toBe(false)
    })
  })

  describe('reset', () => {
    it('should clear the encoded signature', async () => {
      const capture = useSignatureCapture()
      await capture.encode(fakeCanvas(pngBlob()))
      expect(capture.encoded.value).not.toBeNull()
      capture.reset()
      expect(capture.encoded.value).toBeNull()
      expect(capture.error.value).toBeNull()
    })
  })
})
