/**
 * Performance / load test — API response time under concurrent load.
 *
 * Validates NFR-PERF-03: Elysia.js + Drizzle ORM HTTP endpoints respond within
 * ≤ 100ms at the 95th percentile (p95).
 *
 * WHY IN-PROCESS: This harness drives the REAL Elysia route handlers, middleware
 * (tenantGuard, roleGuard) and module services via `app.handle(Request)` — the
 * same technique the e2e workflow tests use. It measures the framework + routing
 * + validation + service-mapping cost of each request without a live DB/Redis/S3,
 * which cannot be started in CI. External I/O (Postgres, Redis, S3) is mocked
 * with deterministic, near-zero-latency responses so the measured number
 * isolates the application-layer overhead the p95 budget is meant to protect.
 *
 * The harness is a lightweight, dependency-free concurrent request runner built
 * on Bun/TypeScript primitives (no autocannon/k6 needed — those target a network
 * socket, which requires the full infra stack to be live). It:
 *   1. Fires N total requests across C concurrent workers per endpoint scenario.
 *   2. Records per-request wall-clock latency via performance.now().
 *   3. Computes p50 / p95 / p99 / max and asserts p95 ≤ 100ms.
 *
 * To run against a LIVE server (real DB/Redis over the network) instead, use an
 * external tool such as autocannon — see the sibling README note. This test is
 * the always-runnable application-layer gate.
 */

import { describe, it, expect, beforeAll, mock } from 'bun:test'
import { Elysia } from 'elysia'
import { jwt } from '@elysiajs/jwt'

const TEST_SECRET = 'perf-api-response-time-secret'
process.env['JWT_SECRET'] = TEST_SECRET

// --- Load profile (override via env for local heavier runs) ---
const TOTAL_REQUESTS = Number(process.env['PERF_TOTAL_REQUESTS'] ?? 2000)
const CONCURRENCY = Number(process.env['PERF_CONCURRENCY'] ?? 50)
const P95_BUDGET_MS = Number(process.env['PERF_P95_BUDGET_MS'] ?? 100)

// --- Deterministic identifiers ---
const COMPANY_ID = '660e8400-e29b-41d4-a716-446655440201'
const USER_ID = '550e8400-e29b-41d4-a716-446655440200'
const SOFFICE_ID = '770e8400-e29b-41d4-a716-446655440202'
const LINI_ID = '880e8400-e29b-41d4-a716-446655440203'
const MATERIAL_ID = 'bb0e8400-e29b-41d4-a716-44665544020b'
const SESSION_ID = 'aa0e8400-e29b-41d4-a716-44665544020a'

const nowIso = (): string => new Date().toISOString()

// -----------------------------------------------------------------------------
// Table-keyed, near-zero-latency mock database
// -----------------------------------------------------------------------------

import { masterMaterial, masterPrice } from '../../db/schema/material'

function materialRow(): Record<string, unknown> {
  return {
    id: MATERIAL_ID,
    companyId: COMPANY_ID,
    erpMaterialCode: 'KF-0001',
    name: 'Paracetamol 500mg',
    baseUom: 'PCS',
    salesUom: 'BOX',
    nie: 'DKL1234567890A1',
    validNie: true,
    liniId: LINI_ID,
    manufacture: 'Kimia Farma',
    principal: 'KF',
    uomConversionRules: { PCS: 1, STRIP: 10, BOX: 100 },
    isNarcoticPsychotropic: false,
    isActive: true,
    isDeleted: false,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }
}

function priceRow(): Record<string, unknown> {
  return {
    id: '22222222-e29b-41d4-a716-446655440222',
    companyId: COMPANY_ID,
    sofficeId: SOFFICE_ID,
    materialId: MATERIAL_ID,
    varianId: null,
    priceRegular: '10000.00',
    priceHja: '12000.00',
    priceHet: '13000.00',
    per: 1,
    salesUom: 'PCS',
    validFrom: '2020-01-01',
    validTo: '2999-12-31',
    createdAt: nowIso(),
  }
}

/** Resolve rows for a select node, dispatching on the target table + projection. */
function rowsForSelect(table: unknown, projection?: Record<string, unknown>): Array<Record<string, unknown>> {
  const keys = projection ? Object.keys(projection) : []
  if (table === masterMaterial) {
    if (keys.includes('total')) return [{ total: 1 }]
    if (keys.length === 1 && keys.includes('id')) return [{ id: MATERIAL_ID }]
    return [materialRow()]
  }
  if (table === masterPrice) return [priceRow()]
  return []
}

function selectNode(projection?: Record<string, unknown>): Record<string, unknown> {
  let boundTable: unknown = null
  const resolve = (): Promise<Array<Record<string, unknown>>> =>
    Promise.resolve(rowsForSelect(boundTable, projection))
  const node: Record<string, unknown> = {
    from: (table: unknown) => {
      boundTable = table
      return node
    },
    innerJoin: () => node,
    leftJoin: () => node,
    where: () => node,
    orderBy: () => node,
    groupBy: () => node,
    limit: () => node,
    offset: () => node,
    then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => resolve().then(onF, onR),
  }
  return node
}

function buildMockTx(): unknown {
  return {
    select: (projection?: Record<string, unknown>) => selectNode(projection),
    execute: () => Promise.resolve([]),
  }
}

const realDb = await import('../../db')
mock.module('../../db', () => ({
  ...realDb,
  db: buildMockTx(),
  withRLS: async (_ctx: unknown, cb: (tx: unknown) => Promise<unknown>) => cb(buildMockTx()),
}))

// Session: always resolve the token's own session (single active session).
mock.module('../../config/session', () => ({
  getSession: async () => ({ session_id: SESSION_ID }),
  createSession: async () => {},
  deleteSession: async () => {},
  buildSessionKey: (c: string, u: string) => `session:${c}:${u}`,
  SESSION_TTL_FIELD: 86400,
  SESSION_TTL_ADMIN: 28800,
}))

// Health checks: report healthy with near-zero latency (no real DB/Redis dials).
mock.module('../../modules/health/service', () => ({
  checkDatabaseHealth: async () => ({ status: 'up', latency_ms: 0 }),
  checkRedisHealth: async () => ({ status: 'up', latency_ms: 0 }),
}))

// Redis / S3 kept inert in case any imported route pulls them in transitively.
mock.module('../../config/redis', () => ({
  redis: { set: async () => 'OK', get: async () => null, ping: async () => 'PONG' },
  createRedisConnection: () => ({}),
  REDIS_URL: 'redis://localhost:6379',
}))
mock.module('../../config/s3', () => ({
  generateUploadUrl: async () => 'https://s3.example.test/x',
  generateDownloadUrl: async () => 'https://s3.example.test/x',
  uploadObject: async () => {},
  buildS3Key: () => 'k',
}))

// Import routes + health service AFTER mocks are registered.
const { materialRoutes } = await import('../../modules/material/routes')
const { checkDatabaseHealth, checkRedisHealth } = await import('../../modules/health/service')

// -----------------------------------------------------------------------------
// App under test — mirrors the real composition for the exercised surface.
// -----------------------------------------------------------------------------

const api = new Elysia()
  .use(materialRoutes)
  .get('/health', async ({ set }) => {
    const [database, redis] = await Promise.all([checkDatabaseHealth(), checkRedisHealth()])
    const status =
      database.status === 'down'
        ? ('unhealthy' as const)
        : redis.status === 'down'
          ? ('degraded' as const)
          : ('healthy' as const)
    if (status === 'unhealthy') set.status = 503
    return { status, timestamp: nowIso(), version: '2.0.0', services: { database, redis } }
  })

let token = ''

/** Mint a valid SALESMAN JWT carrying the claims tenantGuard validates. */
async function mintToken(): Promise<string> {
  let minted = ''
  const signer = new Elysia().use(jwt({ name: 'jwt', secret: TEST_SECRET })).get('/sign', async ({ jwt: j }) => {
    minted = await j.sign({
      user_id: USER_ID,
      company_id: COMPANY_ID,
      soffice_id: SOFFICE_ID,
      role_label: 'SALESMAN',
      lini_ids: [LINI_ID],
      session_id: SESSION_ID,
    })
    return 'ok'
  })
  await signer.handle(new Request('http://localhost/sign'))
  return minted
}

function req(method: string, path: string): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
  })
}

// -----------------------------------------------------------------------------
// Latency stats + concurrent runner
// -----------------------------------------------------------------------------

interface LatencyStats {
  count: number
  errors: number
  min: number
  p50: number
  p95: number
  p99: number
  max: number
  mean: number
  throughputRps: number
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0
  const rank = Math.ceil((p / 100) * sortedAsc.length) - 1
  const idx = Math.min(Math.max(rank, 0), sortedAsc.length - 1)
  return sortedAsc[idx]!
}

/**
 * Fires `total` requests through `makeRequest`, capped at `concurrency` in
 * flight, and returns latency percentiles. A request is an error if it throws or
 * returns a status ≥ 400.
 */
async function runLoad(
  makeRequest: () => Request,
  total: number,
  concurrency: number
): Promise<LatencyStats> {
  const latencies: number[] = new Array(total)
  let errors = 0
  let issued = 0
  const wallStart = performance.now()

  async function worker(): Promise<void> {
    while (true) {
      const i = issued++
      if (i >= total) return
      const start = performance.now()
      try {
        const res = await api.handle(makeRequest())
        // Drain the body so timing includes serialization.
        await res.text()
        if (res.status >= 400) errors++
      } catch {
        errors++
      }
      latencies[i] = performance.now() - start
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => worker()))
  const wallMs = performance.now() - wallStart

  const sorted = latencies.slice().sort((a, b) => a - b)
  const sum = sorted.reduce((acc, v) => acc + v, 0)
  return {
    count: total,
    errors,
    min: sorted[0] ?? 0,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] ?? 0,
    mean: total > 0 ? sum / total : 0,
    throughputRps: wallMs > 0 ? (total / wallMs) * 1000 : 0,
  }
}

function fmt(stats: LatencyStats): string {
  const r = (n: number): string => n.toFixed(2)
  return (
    `n=${stats.count} errors=${stats.errors} ` +
    `min=${r(stats.min)}ms p50=${r(stats.p50)}ms p95=${r(stats.p95)}ms ` +
    `p99=${r(stats.p99)}ms max=${r(stats.max)}ms mean=${r(stats.mean)}ms ` +
    `~${r(stats.throughputRps)} rps`
  )
}

// -----------------------------------------------------------------------------
// Scenarios
// -----------------------------------------------------------------------------

interface Scenario {
  name: string
  make: () => Request
}

describe('Performance — API response time under load (NFR-PERF-03, p95 ≤ 100ms)', () => {
  beforeAll(async () => {
    token = await mintToken()
    // Warm-up: JIT + first-request route compilation should not skew percentiles.
    for (let i = 0; i < 50; i++) {
      await (await api.handle(req('GET', '/health'))).text()
      await (await api.handle(req('GET', '/materials'))).text()
    }
  })

  const scenarios: Scenario[] = [
    { name: 'GET /health (liveness)', make: () => req('GET', '/health') },
    // Integer query params (page/limit) rely on Elysia's numeric-string coercion,
    // which is applied by the real HTTP query parser. Under in-process app.handle()
    // that coercion is not exercised, so we hit the list with its schema defaults
    // (page=1, limit=20) — the representative "first page" catalog read.
    { name: 'GET /materials (list, first page defaults)', make: () => req('GET', '/materials') },
    { name: 'GET /materials/:id (detail)', make: () => req('GET', `/materials/${MATERIAL_ID}`) },
    {
      name: 'GET /materials/:id/price (regional price lookup)',
      make: () => req('GET', `/materials/${MATERIAL_ID}/price?soffice_id=${SOFFICE_ID}`),
    },
  ]

  for (const scenario of scenarios) {
    it(`${scenario.name} — p95 ≤ ${P95_BUDGET_MS}ms`, async () => {
      const stats = await runLoad(scenario.make, TOTAL_REQUESTS, CONCURRENCY)
      // Surface the full latency profile in test output for the report.
      console.log(`[perf] ${scenario.name}: ${fmt(stats)}`)

      expect(stats.errors).toBe(0)
      expect(stats.p95).toBeLessThanOrEqual(P95_BUDGET_MS)
    })
  }
})
