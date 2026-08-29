import { describe, it, expect, mock, beforeEach } from 'bun:test'

// --- Mock transaction state (configurable per test) ---
interface MockTxState {
  ownedVisitRows: Array<Record<string, unknown>>
}

let txState: MockTxState

function resetTxState(): void {
  txState = {
    ownedVisitRows: [
      { id: 'visit-1', companyId: 'company-1', userId: 'user-1', visitOutAt: null },
    ],
  }
}

resetTxState()

/**
 * Builds a mock Drizzle transaction. `generateSignatureUploadUrl` only performs
 * a single `.select()...limit()` chain via `fetchOwnedVisit`.
 */
function buildMockTx() {
  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    limit: () => Promise.resolve(txState.ownedVisitRows),
  }
  return {
    select: () => selectChain,
  }
}

// --- Track S3 helper invocations ---
const buildS3KeyCalls: Array<Record<string, unknown>> = []
const generateUploadUrlCalls: Array<Record<string, unknown>> = []

mock.module('../../../db', () => ({
  withRLS: (_ctx: unknown, cb: (tx: unknown) => Promise<unknown>) => cb(buildMockTx()),
  resolveGeofenceTarget: () => Promise.resolve({ latitude: 0, longitude: 0 }),
}))

mock.module('../../../config/s3', () => ({
  buildS3Key: (opts: Record<string, unknown>) => {
    buildS3KeyCalls.push(opts)
    return `${opts.companyId}/${opts.category}/2025/${opts.fileId}.${opts.extension}`
  },
  generateUploadUrl: (opts: Record<string, unknown>) => {
    generateUploadUrlCalls.push(opts)
    return Promise.resolve(`https://s3.example.test/${opts.key as string}?signed=1`)
  },
}))

const { generateSignatureUploadUrl } = await import('../service')

const ctx = {
  companyId: 'company-1',
  userId: 'user-1',
  sofficeId: 'soffice-1',
  userRole: 'SALESMAN',
}

describe('visit/service — signature upload URL', () => {
  beforeEach(() => {
    resetTxState()
    buildS3KeyCalls.length = 0
    generateUploadUrlCalls.length = 0
  })

  it('should return a pre-signed URL, s3 key, and expiry for an owned open visit', async () => {
    const result = await generateSignatureUploadUrl('visit-1', { content_type: 'image/png' }, ctx)

    expect(result.expires_in).toBe(900)
    expect(result.s3_key).toContain('company-1/visits/signatures/')
    expect(result.s3_key.endsWith('.png')).toBe(true)
    expect(result.upload_url).toContain(result.s3_key)
  })

  it('should build the S3 key under the visits/signatures category with png extension', async () => {
    await generateSignatureUploadUrl('visit-1', { content_type: 'image/png' }, ctx)

    expect(buildS3KeyCalls).toHaveLength(1)
    expect(buildS3KeyCalls[0]).toMatchObject({
      companyId: 'company-1',
      category: 'visits/signatures',
      extension: 'png',
    })
    // fileId must be a generated UUID, never a client-controlled value
    expect(typeof buildS3KeyCalls[0]?.fileId).toBe('string')
  })

  it('should request the pre-signed PUT URL with the png content type', async () => {
    await generateSignatureUploadUrl('visit-1', { content_type: 'image/png' }, ctx)

    expect(generateUploadUrlCalls).toHaveLength(1)
    expect(generateUploadUrlCalls[0]).toMatchObject({
      contentType: 'image/png',
      expiresIn: 900,
    })
  })

  it('should scope the S3 key to the tenant company_id (multi-tenant isolation)', async () => {
    const otherTenantCtx = { ...ctx, companyId: 'company-2' }
    txState.ownedVisitRows = [
      { id: 'visit-1', companyId: 'company-2', userId: 'user-1', visitOutAt: null },
    ]

    const result = await generateSignatureUploadUrl('visit-1', { content_type: 'image/png' }, otherTenantCtx)

    expect(result.s3_key.startsWith('company-2/')).toBe(true)
  })

  it('should throw VISIT_NOT_FOUND (404) when the visit does not exist', async () => {
    txState.ownedVisitRows = []

    await expect(
      generateSignatureUploadUrl('missing-visit', { content_type: 'image/png' }, ctx)
    ).rejects.toMatchObject({ code: 'VISIT_NOT_FOUND', status: 404 })

    expect(generateUploadUrlCalls).toHaveLength(0)
  })

  it('should throw VISIT_NOT_OWNED (403) when the visit belongs to another user', async () => {
    txState.ownedVisitRows = [
      { id: 'visit-1', companyId: 'company-1', userId: 'other-user', visitOutAt: null },
    ]

    await expect(
      generateSignatureUploadUrl('visit-1', { content_type: 'image/png' }, ctx)
    ).rejects.toMatchObject({ code: 'VISIT_NOT_OWNED', status: 403 })

    expect(generateUploadUrlCalls).toHaveLength(0)
  })

  it('should throw VISIT_ALREADY_ENDED (409) when the visit is already completed', async () => {
    txState.ownedVisitRows = [
      {
        id: 'visit-1',
        companyId: 'company-1',
        userId: 'user-1',
        visitOutAt: '2025-01-01T10:00:00.000Z',
      },
    ]

    await expect(
      generateSignatureUploadUrl('visit-1', { content_type: 'image/png' }, ctx)
    ).rejects.toMatchObject({ code: 'VISIT_ALREADY_ENDED', status: 409 })

    expect(generateUploadUrlCalls).toHaveLength(0)
  })
})
