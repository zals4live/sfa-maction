import { describe, it, expect, mock, beforeEach } from 'bun:test'

// --- Track mock state ---
let mockRedisStore: Record<string, string> = {}
let mockInsertCalled = false

mock.module('../../config/redis', () => ({
  redis: {
    incr: (key: string) => {
      const current = parseInt(mockRedisStore[key] ?? '0', 10) + 1
      mockRedisStore[key] = String(current)
      return Promise.resolve(current)
    },
    expire: () => Promise.resolve(1),
    del: (key: string) => {
      delete mockRedisStore[key]
      return Promise.resolve(1)
    },
  },
}))

mock.module('../../db', () => ({
  withRLS: async (_ctx: unknown, cb: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      insert: () => ({
        values: () => {
          mockInsertCalled = true
          return Promise.resolve()
        },
      }),
    }
    return cb(tx)
  },
}))

const {
  buildGraduatedFraudResponse,
  resetFraudCount,
  computeEscalatedSeverity,
} = await import('../fraudResponse')

describe('fraudResponse', () => {
  beforeEach(() => {
    mockRedisStore = {}
    mockInsertCalled = false
  })

  describe('computeEscalatedSeverity', () => {
    it('returns base severity for first occurrence', () => {
      expect(computeEscalatedSeverity('LOW', 1)).toBe('LOW')
      expect(computeEscalatedSeverity('MEDIUM', 1)).toBe('MEDIUM')
      expect(computeEscalatedSeverity('HIGH', 1)).toBe('HIGH')
    })

    it('escalates to MEDIUM for 2-3 consecutive occurrences', () => {
      expect(computeEscalatedSeverity('LOW', 2)).toBe('MEDIUM')
      expect(computeEscalatedSeverity('LOW', 3)).toBe('MEDIUM')
    })

    it('escalates to HIGH for 4-5 consecutive occurrences', () => {
      expect(computeEscalatedSeverity('LOW', 4)).toBe('HIGH')
      expect(computeEscalatedSeverity('MEDIUM', 5)).toBe('HIGH')
    })

    it('escalates to CRITICAL for 6+ consecutive occurrences', () => {
      expect(computeEscalatedSeverity('LOW', 6)).toBe('CRITICAL')
      expect(computeEscalatedSeverity('MEDIUM', 10)).toBe('CRITICAL')
    })
  })

  describe('buildGraduatedFraudResponse', () => {
    const baseTelemetryParams = {
      companyId: '11111111-1111-1111-1111-111111111111',
      userId: '22222222-2222-2222-2222-222222222222',
      userRole: 'SALESMAN',
      fraudType: 'MOCK_LOCATION' as const,
      gps: {
        lat: -6.2088,
        lng: 106.8456,
        accuracy: 10,
        client_timestamp: Date.now(),
        is_mock_provider: true,
      },
    }

    const baseFraudDetection = {
      type: 'MOCK_LOCATION' as const,
      severity: 'MEDIUM' as const,
      details: { is_mock_provider: true },
    }

    it('returns a blocked response on first fraud event', async () => {
      const result = await buildGraduatedFraudResponse(baseTelemetryParams, baseFraudDetection)

      expect(result.blocked).toBe(true)
      expect(result.consecutiveCount).toBe(1)
      expect(result.adminNotifyRequired).toBe(false)
      expect(result.error.code).toBe('GEOFENCE_SPOOF_DETECTED')
    })

    it('increments consecutive count on repeated fraud events', async () => {
      await buildGraduatedFraudResponse(baseTelemetryParams, baseFraudDetection)
      const result = await buildGraduatedFraudResponse(baseTelemetryParams, baseFraudDetection)

      expect(result.consecutiveCount).toBe(2)
    })

    it('includes user notification with non-aggressive message', async () => {
      const result = await buildGraduatedFraudResponse(baseTelemetryParams, baseFraudDetection)

      expect(result.notification.title).toBe('GPS Verification Failed')
      expect(result.notification.message).toContain('mock location provider')
      expect(result.notification.severity).toBeDefined()
    })

    it('flags admin notification after threshold (6+ events)', async () => {
      // Simulate 5 prior events
      mockRedisStore['fraud:count:22222222-2222-2222-2222-222222222222'] = '5'

      const result = await buildGraduatedFraudResponse(baseTelemetryParams, baseFraudDetection)

      expect(result.consecutiveCount).toBe(6)
      expect(result.adminNotifyRequired).toBe(true)
    })

    it('does not flag admin notification below threshold', async () => {
      mockRedisStore['fraud:count:22222222-2222-2222-2222-222222222222'] = '3'

      const result = await buildGraduatedFraudResponse(baseTelemetryParams, baseFraudDetection)

      expect(result.consecutiveCount).toBe(4)
      expect(result.adminNotifyRequired).toBe(false)
    })

    it('logs telemetry to audit_fraud_telemetry', async () => {
      await buildGraduatedFraudResponse(baseTelemetryParams, baseFraudDetection)
      // Telemetry is fire-and-forget; allow the floating promise to settle.
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(mockInsertCalled).toBe(true)
    })

    it('includes consecutive count and escalated severity in error details', async () => {
      mockRedisStore['fraud:count:22222222-2222-2222-2222-222222222222'] = '3'

      const result = await buildGraduatedFraudResponse(baseTelemetryParams, baseFraudDetection)

      expect(result.error.details.consecutive_count).toBe(4)
      expect(result.error.details.escalated_severity).toBe('HIGH')
    })

    it('provides type-specific notification for velocity anomaly', async () => {
      const velocityParams = { ...baseTelemetryParams, fraudType: 'VELOCITY_ANOMALY' as const }
      const velocityDetection = {
        type: 'VELOCITY_ANOMALY' as const,
        severity: 'HIGH' as const,
        details: { calculated_speed_kmh: 200 },
      }

      const result = await buildGraduatedFraudResponse(velocityParams, velocityDetection)

      expect(result.notification.message).toContain('unusual travel speed')
    })

    it('provides type-specific notification for clock drift', async () => {
      const clockParams = { ...baseTelemetryParams, fraudType: 'CLOCK_DRIFT' as const }
      const clockDetection = {
        type: 'CLOCK_DRIFT' as const,
        severity: 'MEDIUM' as const,
        details: { clock_drift_seconds: 45 },
      }

      const result = await buildGraduatedFraudResponse(clockParams, clockDetection)

      expect(result.notification.message).toContain('clock appears out of sync')
    })
  })

  describe('resetFraudCount', () => {
    it('removes the fraud counter from Redis', async () => {
      mockRedisStore['fraud:count:user-123'] = '5'

      await resetFraudCount('user-123')

      expect(mockRedisStore['fraud:count:user-123']).toBeUndefined()
    })
  })
})
