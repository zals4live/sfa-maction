import { describe, it, expect, spyOn } from 'bun:test'
import { PutObjectCommand } from '@aws-sdk/client-s3'

import { uploadObject, buildS3Key, s3Client } from '../s3'

describe('config/s3', () => {
  describe('buildS3Key', () => {
    it('builds a tenant-prefixed quotations key with the current year', () => {
      const key = buildS3Key({
        companyId: 'company-1',
        category: 'orders/quotations',
        fileId: 'file-1',
        extension: 'pdf',
      })
      const year = new Date().getFullYear()
      expect(key).toBe(`company-1/orders/quotations/${year}/file-1.pdf`)
    })

    it('strips a leading dot from the extension', () => {
      const key = buildS3Key({
        companyId: 'c',
        category: 'orders/quotations',
        fileId: 'f',
        extension: '.pdf',
      })
      expect(key.endsWith('/f.pdf')).toBe(true)
    })
  })

  describe('uploadObject', () => {
    it('sends a PutObjectCommand with the key, body, and content type', async () => {
      const sendSpy = spyOn(s3Client, 'send').mockResolvedValue(undefined as never)
      const body = new Uint8Array([1, 2, 3, 4])

      await uploadObject({ key: 'company-1/orders/quotations/2025/x.pdf', body, contentType: 'application/pdf' })

      expect(sendSpy).toHaveBeenCalledTimes(1)
      const command = sendSpy.mock.calls[0]![0] as PutObjectCommand
      expect(command).toBeInstanceOf(PutObjectCommand)
      expect(command.input.Key).toBe('company-1/orders/quotations/2025/x.pdf')
      expect(command.input.Body).toBe(body)
      expect(command.input.ContentType).toBe('application/pdf')

      sendSpy.mockRestore()
    })

    it('propagates errors from the S3 client', async () => {
      const sendSpy = spyOn(s3Client, 'send').mockRejectedValue(new Error('network down') as never)

      await expect(
        uploadObject({ key: 'k', body: new Uint8Array([0]), contentType: 'application/pdf' })
      ).rejects.toThrow('network down')

      sendSpy.mockRestore()
    })
  })
})
