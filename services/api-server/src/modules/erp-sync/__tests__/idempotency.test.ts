import { describe, it, expect, beforeEach, mock } from 'bun:test'

// Redis SET NX result is configurable per test: 'OK' = claim won (first
// delivery), null = duplicate (key already present). Defaults to 'OK'. Each
// call's args are recorded so we can assert the atomic SET NX EX contract.
const redisSet: { result: 'OK' | null; calls: unknown[][] } = { result: 'OK', calls: [] }

mock.module('../../../config/redis', () => ({
  redis: {
    set: (...args: unknown[]) => {
      redisSet.calls.push(args)
      return Promise.resolve(redisSet.result)
    },
  },
}))

const {
  generateIdempotencyKey,
  buildIdempotencyKey,
  claimIdempotencyKey,
  IDEMPOTENCY_PREFIX,
  IDEMPOTENCY_TTL_SECONDS,
} = await import('../idempotency')

const COMPANY_ID = '660e8400-e29b-41d4-a716-446655440001'
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

beforeEach(() => {
  redisSet.result = 'OK'
  redisSet.calls.length = 0
})

describe('generateIdempotencyKey', () => {
  it('produces a valid UUID v4', () => {
    expect(generateIdempotencyKey()).toMatch(UUID_V4)
  })

  it('produces unique keys across calls', () => {
    const keys = new Set(Array.from({ length: 100 }, () => generateIdempotencyKey()))
    expect(keys.size).toBe(100)
  })
})

describe('buildIdempotencyKey', () => {
  it('namespaces by prefix, tenant, and scope', () => {
    const key = buildIdempotencyKey(COMPANY_ID, 'order', 'abc')
    expect(key).toBe(`${IDEMPOTENCY_PREFIX}:${COMPANY_ID}:order:abc`)
  })

  it('separates scopes so inbound and outbound never collide', () => {
    const inbound = buildIdempotencyKey(COMPANY_ID, 'customers', 'k')
    const outbound = buildIdempotencyKey(COMPANY_ID, 'order', 'k')
    expect(inbound).not.toBe(outbound)
  })
})

describe('claimIdempotencyKey', () => {
  it('returns true when the claim is won (SET NX returns OK)', async () => {
    redisSet.result = 'OK'
    const won = await claimIdempotencyKey(COMPANY_ID, 'order', 'key-1')
    expect(won).toBe(true)
  })

  it('returns false on a duplicate (SET NX returns null)', async () => {
    redisSet.result = null
    const won = await claimIdempotencyKey(COMPANY_ID, 'order', 'key-1')
    expect(won).toBe(false)
  })

  it('issues an atomic SET NX with the 24h EX TTL and namespaced key', async () => {
    await claimIdempotencyKey(COMPANY_ID, 'materials', 'key-9')
    expect(redisSet.calls).toHaveLength(1)
    expect(redisSet.calls[0]).toEqual([
      `${IDEMPOTENCY_PREFIX}:${COMPANY_ID}:materials:key-9`,
      '1',
      'EX',
      IDEMPOTENCY_TTL_SECONDS,
      'NX',
    ])
    expect(IDEMPOTENCY_TTL_SECONDS).toBe(86_400)
  })
})
