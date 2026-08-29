import { describe, it, expect, mock, beforeEach } from 'bun:test'
import { FraudType } from '@maction/types'

// --- Track mock state ---
let capturedRlsCtx: unknown = null
let capturedRow: Record<string, unknown> | null = null
let insertCalled = false
let shouldThrow = false

mock.module('../../../db', () => ({
  withRLS: async (ctx: unknown, cb: (tx: unknown) => Promise<unknown>) => {
    capturedRlsCtx = ctx
    if (shouldThrow) throw new Error('db failure')
    const tx = {
      insert: () => ({
        values: (row: Record<string, unknown>) => {
          insertCalled = true
          capturedRow = row
          return Promise.resolve()
        },
      }),
    }
    return cb(tx)
  },
}))

const { logFraudTelemetry, recordFraudTelemetry } = await import('../fraudTelemetryService')

const baseCtx = {
  companyId: '11111111-1111-1111-1111-111111111111',
  userId: '22222222-2222-2222-2222-222222222222',
  userRole: 'SALESMAN',
  clientIp: '203.0.113.7',
}

const velocityRecord = {
  fraudType: FraudType.VELOCITY_ANOMALY,
  severity: 'HIGH' as const,
  claimedLat: -6.2,
  claimedLng: 106.8,
  claimedAccuracyMeters: 12,
  calculatedSpeedKmh: 240.5,
  clientTimestamp: '2024-01-01T08:00:00.000Z',
  deviceInfo: { model: 'Pixel 7' },
  isMockProvider: false,
  rawPayload: { lat: -6.2, lng: 106.8 },
  requestEndpoint: '/visits/start',
}

describe('fraud telemetry service', () => {
  beforeEach(() => {
    capturedRlsCtx = null
    capturedRow = null
    insertCalled = false
    shouldThrow = false
  })

  describe('logFraudTelemetry', () => {
    it('should set RLS context from tenant + user + role', async () => {
      await logFraudTelemetry(baseCtx, velocityRecord)

      expect(capturedRlsCtx).toEqual({
        companyId: baseCtx.companyId,
        userId: baseCtx.userId,
        userRole: baseCtx.userRole,
      })
    })

    it('should persist company_id, user_id and client_ip from context', async () => {
      await logFraudTelemetry(baseCtx, velocityRecord)

      expect(capturedRow?.companyId).toBe(baseCtx.companyId)
      expect(capturedRow?.userId).toBe(baseCtx.userId)
      expect(capturedRow?.clientIp).toBe(baseCtx.clientIp)
    })

    it('should map structured telemetry fields onto the row', async () => {
      await logFraudTelemetry(baseCtx, velocityRecord)

      expect(capturedRow?.fraudType).toBe(FraudType.VELOCITY_ANOMALY)
      expect(capturedRow?.severity).toBe('HIGH')
      expect(capturedRow?.calculatedSpeedKmh).toBe(240.5)
      expect(capturedRow?.claimedLat).toBe(-6.2)
      expect(capturedRow?.claimedLng).toBe(106.8)
      expect(capturedRow?.deviceInfo).toEqual({ model: 'Pixel 7' })
      expect(capturedRow?.rawPayload).toEqual({ lat: -6.2, lng: 106.8 })
      expect(capturedRow?.requestEndpoint).toBe('/visits/start')
    })

    it('should default severity to LOW and action to SOFT_REJECT when omitted', async () => {
      await logFraudTelemetry(baseCtx, { fraudType: FraudType.ACCURACY_EXCESS })

      expect(capturedRow?.severity).toBe('LOW')
      expect(capturedRow?.actionTaken).toBe('SOFT_REJECT')
      expect(capturedRow?.isMockProvider).toBe(false)
    })

    it('should coalesce all missing optional metrics to null', async () => {
      await logFraudTelemetry(baseCtx, { fraudType: FraudType.CLOCK_DRIFT })

      expect(capturedRow?.claimedLat).toBeNull()
      expect(capturedRow?.claimedLng).toBeNull()
      expect(capturedRow?.claimedAccuracyMeters).toBeNull()
      expect(capturedRow?.calculatedSpeedKmh).toBeNull()
      expect(capturedRow?.distanceFromTargetMeters).toBeNull()
      expect(capturedRow?.clockDriftSeconds).toBeNull()
      expect(capturedRow?.deviceInfo).toBeNull()
      expect(capturedRow?.rawPayload).toBeNull()
      expect(capturedRow?.requestEndpoint).toBeNull()
    })

    it('should coalesce a missing client_ip to null', async () => {
      await logFraudTelemetry(
        { companyId: baseCtx.companyId, userId: baseCtx.userId, userRole: 'MR' },
        { fraudType: FraudType.MOCK_LOCATION },
      )

      expect(capturedRow?.clientIp).toBeNull()
    })
  })

  describe('recordFraudTelemetry', () => {
    it('should perform the insert through the RLS-scoped write', async () => {
      recordFraudTelemetry(baseCtx, velocityRecord)
      await Promise.resolve()

      expect(insertCalled).toBe(true)
    })

    it('should swallow DB errors so the soft-rejection flow never breaks', async () => {
      shouldThrow = true

      expect(() => recordFraudTelemetry(baseCtx, velocityRecord)).not.toThrow()
      await Promise.resolve()
    })
  })
})
