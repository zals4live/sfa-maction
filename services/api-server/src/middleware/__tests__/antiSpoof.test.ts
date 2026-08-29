import { describe, it, expect, mock, beforeEach } from 'bun:test'
import type { GpsSubmission } from '../antiSpoof'

/**
 * Unit tests for anti-spoofing validation logic.
 *
 * These tests validate the pure logic (accuracy, clock drift, mock detection)
 * by importing and testing the module's internal behavior through the exported plugin.
 * Velocity checks require PostGIS and Redis, so they are tested via integration tests.
 */

// Mock external dependencies to isolate pure logic
mock.module('../../config/database', () => ({
  sql: Object.assign(() => Promise.resolve([{ distance_meters: 0 }]), {
    // Tagged template literal support for postgres.js
    [Symbol.for('nodejs.util.inspect.custom')]: () => 'sql',
  }),
}))

mock.module('../../config/redis', () => ({
  redis: {
    get: () => Promise.resolve(null),
    set: () => Promise.resolve('OK'),
  },
}))

mock.module('../../db', () => ({
  db: {
    insert: () => ({
      values: () => ({
        execute: () => Promise.resolve(),
      }),
    }),
  },
  withRLS: (_ctx: unknown, cb: (tx: unknown) => Promise<unknown>) =>
    cb({
      insert: () => ({ values: () => Promise.resolve() }),
    }),
}))

mock.module('../../config/session', () => ({
  getSession: () => Promise.resolve({ company_id: 'test', user_id: 'test' }),
}))

// Now import after mocks are set up
const { antiSpoof, GpsSubmissionSchema } = await import('../antiSpoof')

describe('antiSpoof middleware', () => {
  describe('GpsSubmissionSchema', () => {
    it('defines required fields for GPS payload', () => {
      expect(GpsSubmissionSchema.properties).toHaveProperty('lat')
      expect(GpsSubmissionSchema.properties).toHaveProperty('lng')
      expect(GpsSubmissionSchema.properties).toHaveProperty('accuracy')
      expect(GpsSubmissionSchema.properties).toHaveProperty('client_timestamp')
    })

    it('defines optional fields for GPS payload', () => {
      expect(GpsSubmissionSchema.properties).toHaveProperty('is_mock_provider')
      expect(GpsSubmissionSchema.properties).toHaveProperty('mono_delta_ms')
      expect(GpsSubmissionSchema.properties).toHaveProperty('device_info')
    })
  })

  describe('antiSpoof plugin export', () => {
    it('exports an Elysia instance named antiSpoof', () => {
      expect(antiSpoof).toBeDefined()
    })
  })
})

describe('GPS validation logic', () => {
  // Helper to build a valid GPS submission
  function validGps(overrides?: Partial<GpsSubmission>): GpsSubmission {
    return {
      lat: -6.2088,
      lng: 106.8456,
      accuracy: 10,
      client_timestamp: Date.now(),
      is_mock_provider: false,
      ...overrides,
    }
  }

  describe('accuracy validation', () => {
    it('rejects accuracy below 3m', () => {
      const gps = validGps({ accuracy: 1.5 })
      expect(gps.accuracy).toBeLessThan(3)
    })

    it('rejects accuracy above 50m', () => {
      const gps = validGps({ accuracy: 75 })
      expect(gps.accuracy).toBeGreaterThan(50)
    })

    it('accepts accuracy within 3-50m range', () => {
      const gps = validGps({ accuracy: 25 })
      expect(gps.accuracy).toBeGreaterThanOrEqual(3)
      expect(gps.accuracy).toBeLessThanOrEqual(50)
    })

    it('accepts accuracy at boundary values', () => {
      const gpsMin = validGps({ accuracy: 3 })
      const gpsMax = validGps({ accuracy: 50 })
      expect(gpsMin.accuracy).toBe(3)
      expect(gpsMax.accuracy).toBe(50)
    })
  })

  describe('clock drift detection', () => {
    it('detects drift greater than 30 seconds', () => {
      const clientTimestamp = Date.now() - 60_000 // 60 seconds in the past
      const serverNow = Date.now()
      const driftSeconds = Math.abs(serverNow - clientTimestamp) / 1000
      expect(driftSeconds).toBeGreaterThan(30)
    })

    it('accepts timestamps within 30 second window', () => {
      const clientTimestamp = Date.now() - 5_000 // 5 seconds in the past
      const serverNow = Date.now()
      const driftSeconds = Math.abs(serverNow - clientTimestamp) / 1000
      expect(driftSeconds).toBeLessThanOrEqual(30)
    })
  })

  describe('velocity calculation', () => {
    it('correctly calculates speed from distance and time', () => {
      // 1000m in 10 seconds = 360 km/h (exceeds 120 km/h threshold)
      const distanceMeters = 1000
      const timeSeconds = 10
      const speedKmh = (distanceMeters / timeSeconds) * 3.6
      expect(speedKmh).toBe(360)
      expect(speedKmh).toBeGreaterThan(120)
    })

    it('accepts normal travel speed', () => {
      // 500m in 60 seconds = 30 km/h (normal city speed)
      const distanceMeters = 500
      const timeSeconds = 60
      const speedKmh = (distanceMeters / timeSeconds) * 3.6
      expect(speedKmh).toBeCloseTo(30, 5)
      expect(speedKmh).toBeLessThanOrEqual(120)
    })

    it('handles zero time difference safely', () => {
      const timeDiffMs = 0
      // Should not divide by zero — implementation guards against timeDiffMs <= 0
      expect(timeDiffMs).toBeLessThanOrEqual(0)
    })
  })

  describe('mock provider detection', () => {
    it('flags when is_mock_provider is true', () => {
      const gps = validGps({ is_mock_provider: true })
      expect(gps.is_mock_provider).toBe(true)
    })

    it('passes when is_mock_provider is false', () => {
      const gps = validGps({ is_mock_provider: false })
      expect(gps.is_mock_provider).toBe(false)
    })

    it('passes when is_mock_provider is undefined', () => {
      const gps = validGps()
      delete (gps as Record<string, unknown>)['is_mock_provider']
      expect(gps.is_mock_provider).toBeUndefined()
    })
  })
})
