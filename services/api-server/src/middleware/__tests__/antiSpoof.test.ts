import { describe, it, expect, mock, beforeEach } from 'bun:test'
import type { GpsSubmission } from '../antiSpoof'
import type { JWTClaims } from '../tenantGuard'

/**
 * Integration tests for the three-layer anti-spoofing pipeline (backend, Layer 3
 * server-side + orchestration of Layers 1 & 2 payload flags).
 *
 * Exercises the real `validateGeoSubmissionImpl` end-to-end against mocked
 * external services (PostGIS via the postgres.js tagged template, Redis, and
 * the fraud telemetry service). Verifies:
 *  - Layer 1: mock-provider detection + accuracy window (3m..50m inclusive)
 *  - Layer 2: monotonic clock drift (> 30s) and backwards timestamp handling
 *  - Layer 3: velocity check via ST_DistanceSphere (> 120 km/h)
 *  - Graduated fraud response: soft reject (block, no ban) + telemetry logging
 *  - Both SALESMAN and MR field roles are validated identically
 *  - Boundary conditions: accuracy at 3m/50m, velocity at 120 km/h, drift at 30s
 */

// --- Controllable PostGIS distance (meters) for the velocity check ---
let mockDistanceMeters = 0

// postgres.js `sql` is a tagged template: sql`SELECT ...` → resolves rows.
mock.module('../../config/database', () => ({
  sql: (..._args: unknown[]) =>
    Promise.resolve([{ distance_meters: mockDistanceMeters }]),
}))

// --- In-memory Redis: last-position store + fraud counter ---
let mockRedisStore: Record<string, string> = {}

mock.module('../../config/redis', () => ({
  redis: {
    get: (key: string) => Promise.resolve(mockRedisStore[key] ?? null),
    set: (key: string, value: string) => {
      mockRedisStore[key] = value
      return Promise.resolve('OK')
    },
    incr: (key: string) => {
      const next = parseInt(mockRedisStore[key] ?? '0', 10) + 1
      mockRedisStore[key] = String(next)
      return Promise.resolve(next)
    },
    expire: () => Promise.resolve(1),
    del: (key: string) => {
      delete mockRedisStore[key]
      return Promise.resolve(1)
    },
  },
}))

// --- Capture telemetry writes (soft-reject audit trail) ---
// Mock the RLS transaction layer (same seam the fraudResponse suite uses) so the
// real recordFraudTelemetry → withRLS → insert path runs and we observe the row.
interface TelemetryRow {
  fraudType: string
  actionTaken?: string
  severity?: string
}
let telemetryRows: TelemetryRow[] = []

mock.module('../../db', () => ({
  withRLS: async (_ctx: unknown, cb: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      insert: () => ({
        values: (row: TelemetryRow) => {
          telemetryRows.push(row)
          return Promise.resolve()
        },
      }),
    }
    return cb(tx)
  },
}))

// Import after mocks are registered so the module binds to them.
const { validateGeoSubmissionImpl, GpsSubmissionSchema } = await import('../antiSpoof')

// --- Fixtures ---

function makeClaims(role: JWTClaims['role_label']): JWTClaims {
  return {
    user_id: `00000000-0000-0000-0000-0000000000${role === 'SALESMAN' ? '01' : '02'}`,
    company_id: '11111111-1111-1111-1111-111111111111',
    soffice_id: '33333333-3333-3333-3333-333333333333',
    role_label: role,
    lini_ids: [],
    session_id: '44444444-4444-4444-4444-444444444444',
  }
}

/** A clean, in-window GPS fix near Jakarta with a fresh timestamp. */
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

/** Seed a prior known position so the Layer-3 velocity check has a baseline. */
function seedLastPosition(userId: string, pos: { lat: number; lng: number; timestamp_ms: number }): void {
  mockRedisStore[`antispoof:lastpos:${userId}`] = JSON.stringify(pos)
}

/** Wait for the fire-and-forget telemetry promise to settle before asserting. */
async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  mockRedisStore = {}
  telemetryRows = []
  mockDistanceMeters = 0
})

describe('GpsSubmissionSchema', () => {
  it('defines the required and optional GPS payload fields', () => {
    expect(GpsSubmissionSchema.properties).toHaveProperty('lat')
    expect(GpsSubmissionSchema.properties).toHaveProperty('lng')
    expect(GpsSubmissionSchema.properties).toHaveProperty('accuracy')
    expect(GpsSubmissionSchema.properties).toHaveProperty('client_timestamp')
    expect(GpsSubmissionSchema.properties).toHaveProperty('is_mock_provider')
    expect(GpsSubmissionSchema.properties).toHaveProperty('mono_delta_ms')
  })
})

describe('anti-spoofing pipeline — happy path', () => {
  it('accepts a clean fix and persists last position + resets fraud counter', async () => {
    const claims = makeClaims('SALESMAN')
    mockRedisStore[`fraud:count:${claims.user_id}`] = '3'

    const result = await validateGeoSubmissionImpl(claims, validGps())

    expect(result.valid).toBe(true)
    expect(result.error).toBeUndefined()
    // Last position stored for the next velocity comparison.
    expect(mockRedisStore[`antispoof:lastpos:${claims.user_id}`]).toBeDefined()
    // Fraud counter cleared on a clean pass.
    expect(mockRedisStore[`fraud:count:${claims.user_id}`]).toBeUndefined()
    await flushAsync()
    expect(telemetryRows).toHaveLength(0)
  })

  it.each(['SALESMAN', 'MR'] as const)(
    'validates the %s field role identically on a clean fix',
    async (role) => {
      const result = await validateGeoSubmissionImpl(makeClaims(role), validGps())
      expect(result.valid).toBe(true)
    }
  )
})

describe('Layer 1 — mock provider detection', () => {
  it.each(['SALESMAN', 'MR'] as const)(
    'soft-rejects a mock-provider fix for %s and logs MOCK_LOCATION telemetry',
    async (role) => {
      const claims = makeClaims(role)
      const result = await validateGeoSubmissionImpl(claims, validGps({ is_mock_provider: true }))

      expect(result.valid).toBe(false)
      expect(result.fraudResponse?.blocked).toBe(true)
      await flushAsync()
      expect(telemetryRows).toHaveLength(1)
      expect(telemetryRows[0]?.fraudType).toBe('MOCK_LOCATION')
      expect(telemetryRows[0]?.actionTaken).toBe('SOFT_REJECT')
    }
  )
})

describe('Layer 1 — accuracy window (3m..50m inclusive)', () => {
  it('soft-rejects accuracy below the 3m minimum', async () => {
    const result = await validateGeoSubmissionImpl(makeClaims('SALESMAN'), validGps({ accuracy: 1.5 }))
    expect(result.valid).toBe(false)
    await flushAsync()
    expect(telemetryRows[0]?.fraudType).toBe('ACCURACY_EXCESS')
  })

  it('soft-rejects accuracy above the 50m maximum', async () => {
    const result = await validateGeoSubmissionImpl(makeClaims('SALESMAN'), validGps({ accuracy: 75 }))
    expect(result.valid).toBe(false)
    await flushAsync()
    expect(telemetryRows[0]?.fraudType).toBe('ACCURACY_EXCESS')
  })

  it('accepts accuracy exactly at the 3m lower boundary', async () => {
    const result = await validateGeoSubmissionImpl(makeClaims('SALESMAN'), validGps({ accuracy: 3 }))
    expect(result.valid).toBe(true)
  })

  it('accepts accuracy exactly at the 50m upper boundary', async () => {
    const result = await validateGeoSubmissionImpl(makeClaims('MR'), validGps({ accuracy: 50 }))
    expect(result.valid).toBe(true)
  })
})

describe('Layer 2 — monotonic clock drift (> 30s)', () => {
  it('soft-rejects a client timestamp drifting more than 30s from server time', async () => {
    const claims = makeClaims('SALESMAN')
    const result = await validateGeoSubmissionImpl(
      claims,
      validGps({ client_timestamp: Date.now() - 60_000 })
    )

    expect(result.valid).toBe(false)
    await flushAsync()
    expect(telemetryRows[0]?.fraudType).toBe('CLOCK_DRIFT')
    expect(result.error?.details['clock_drift_seconds']).toBeGreaterThan(30)
  })

  it('soft-rejects a backwards-jumping (future) client timestamp beyond tolerance', async () => {
    const result = await validateGeoSubmissionImpl(
      makeClaims('MR'),
      validGps({ client_timestamp: Date.now() + 45_000 })
    )
    expect(result.valid).toBe(false)
    await flushAsync()
    expect(telemetryRows[0]?.fraudType).toBe('CLOCK_DRIFT')
  })

  it('accepts drift at exactly the 30s threshold (boundary is inclusive)', async () => {
    const claims = makeClaims('SALESMAN')
    // client is exactly 30s behind; drift == 30 is NOT > 30, so it passes.
    const result = await validateGeoSubmissionImpl(
      claims,
      validGps({ client_timestamp: Date.now() - 30_000 })
    )
    expect(result.valid).toBe(true)
  })
})

describe('Layer 3 — server-side velocity check (> 120 km/h via ST_DistanceSphere)', () => {
  it('soft-rejects an impossible speed between two consecutive fixes', async () => {
    const claims = makeClaims('SALESMAN')
    const now = Date.now()
    // 5000m in 10s = 1800 km/h → anomaly.
    seedLastPosition(claims.user_id, { lat: -6.2, lng: 106.8, timestamp_ms: now - 10_000 })
    mockDistanceMeters = 5000

    const result = await validateGeoSubmissionImpl(claims, validGps({ client_timestamp: now }))

    expect(result.valid).toBe(false)
    await flushAsync()
    expect(telemetryRows[0]?.fraudType).toBe('VELOCITY_ANOMALY')
    expect(result.error?.details['calculated_speed_kmh']).toBeGreaterThan(120)
  })

  it('accepts a normal travel speed between fixes', async () => {
    const claims = makeClaims('MR')
    const now = Date.now()
    // 500m in 60s = 30 km/h → normal.
    seedLastPosition(claims.user_id, { lat: -6.2, lng: 106.8, timestamp_ms: now - 60_000 })
    mockDistanceMeters = 500

    const result = await validateGeoSubmissionImpl(claims, validGps({ client_timestamp: now }))
    expect(result.valid).toBe(true)
    await flushAsync()
    expect(telemetryRows).toHaveLength(0)
  })

  it('accepts a speed just below the 120 km/h threshold', async () => {
    const claims = makeClaims('SALESMAN')
    const now = Date.now()
    // 330m over 10s = 118.8 km/h → just under the threshold, must pass.
    seedLastPosition(claims.user_id, { lat: -6.2, lng: 106.8, timestamp_ms: now - 10_000 })
    mockDistanceMeters = 330

    const result = await validateGeoSubmissionImpl(claims, validGps({ client_timestamp: now }))
    expect(result.valid).toBe(true)
  })

  it('soft-rejects a speed just above the 120 km/h threshold', async () => {
    const claims = makeClaims('SALESMAN')
    const now = Date.now()
    // 340m over 10s = 122.4 km/h → just over the threshold, must reject.
    seedLastPosition(claims.user_id, { lat: -6.2, lng: 106.8, timestamp_ms: now - 10_000 })
    mockDistanceMeters = 340

    const result = await validateGeoSubmissionImpl(claims, validGps({ client_timestamp: now }))
    expect(result.valid).toBe(false)
    await flushAsync()
    expect(telemetryRows[0]?.fraudType).toBe('VELOCITY_ANOMALY')
  })

  it('skips the velocity check when no prior position is anchored', async () => {
    const claims = makeClaims('SALESMAN')
    mockDistanceMeters = 999_999 // would be an anomaly IF a baseline existed
    const result = await validateGeoSubmissionImpl(claims, validGps())
    expect(result.valid).toBe(true)
  })
})

describe('graduated fraud response — soft reject, no hard ban', () => {
  it('blocks the current action but returns no ban directive', async () => {
    const claims = makeClaims('SALESMAN')
    const result = await validateGeoSubmissionImpl(claims, validGps({ is_mock_provider: true }))

    expect(result.valid).toBe(false)
    expect(result.fraudResponse?.blocked).toBe(true)
    // A soft rejection must never escalate to an immediate ban.
    expect(result.fraudResponse?.adminNotifyRequired).toBe(false)
    expect((result.fraudResponse as unknown as Record<string, unknown>)['banned']).toBeUndefined()
  })

  it('logs every soft rejection to telemetry with SOFT_REJECT action', async () => {
    await validateGeoSubmissionImpl(makeClaims('SALESMAN'), validGps({ accuracy: 200 }))
    await flushAsync()
    expect(telemetryRows).toHaveLength(1)
    expect(telemetryRows[0]?.actionTaken).toBe('SOFT_REJECT')
  })
})

describe('layer precedence', () => {
  it('reports mock location before an accuracy problem on the same fix', async () => {
    const result = await validateGeoSubmissionImpl(
      makeClaims('SALESMAN'),
      validGps({ is_mock_provider: true, accuracy: 999 })
    )
    expect(result.valid).toBe(false)
    await flushAsync()
    expect(telemetryRows[0]?.fraudType).toBe('MOCK_LOCATION')
  })

  it('reports accuracy before clock drift on the same fix', async () => {
    const result = await validateGeoSubmissionImpl(
      makeClaims('SALESMAN'),
      validGps({ accuracy: 999, client_timestamp: Date.now() - 60_000 })
    )
    expect(result.valid).toBe(false)
    await flushAsync()
    expect(telemetryRows[0]?.fraudType).toBe('ACCURACY_EXCESS')
  })
})
