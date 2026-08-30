import { describe, it, expect, mock } from 'bun:test'

// --- Isolate the suite from live infra (Redis/DB) ---
// These validation/PDF paths throw before any query, but mocking keeps the
// test hermetic and avoids the eager Redis connection lingering.
mock.module('../../../config/redis', () => ({
  redis: {
    get: () => Promise.resolve(null),
    set: () => Promise.resolve('OK'),
  },
}))

mock.module('../../../db', () => ({
  withRLS: (_ctx: unknown, cb: (tx: unknown) => Promise<unknown>) => cb({}),
}))

import { prepareExport, ServiceError, type ReportContext } from '../service'
import type { ExportQueryParams } from '../schemas'

const ctx: ReportContext = {
  companyId: 'company-1',
  userId: 'user-1',
  userRole: 'ADMIN_CABANG',
}

/** Runs prepareExport and returns the thrown ServiceError (or null). */
async function captureError(
  type: 'xlsx' | 'pdf',
  query: ExportQueryParams
): Promise<ServiceError | null> {
  try {
    await prepareExport({ type }, query, ctx)
    return null
  } catch (err) {
    return err instanceof ServiceError ? err : null
  }
}

describe('report/service — prepareExport validation', () => {
  it('throws MISSING_PARAMETER (400) when branch-performance lacks month/year', async () => {
    const err = await captureError('xlsx', { report: 'branch-performance' })
    expect(err).not.toBeNull()
    expect(err!.code).toBe('MISSING_PARAMETER')
    expect(err!.status).toBe(400)
  })

  it('throws MISSING_PARAMETER (400) when call-rate lacks month/year', async () => {
    const err = await captureError('xlsx', { report: 'call-rate', month: 6 })
    expect(err).not.toBeNull()
    expect(err!.code).toBe('MISSING_PARAMETER')
    expect(err!.status).toBe(400)
  })

  it('leaves PDF export as NOT_IMPLEMENTED (501)', async () => {
    const err = await captureError('pdf', { report: 'dashboard-kpi' })
    expect(err).not.toBeNull()
    expect(err!.code).toBe('NOT_IMPLEMENTED')
    expect(err!.status).toBe(501)
  })
})
