import { describe, it, expect, beforeEach, mock } from 'bun:test'

// Mock Redis before importing the rate limiter
let mockStore: Record<string, number> = {}
let mockTtl: Record<string, number> = {}

mock.module('../../config/redis', () => ({
  redis: {
    incr: async (key: string) => {
      mockStore[key] = (mockStore[key] ?? 0) + 1
      return mockStore[key]
    },
    expire: async (key: string, seconds: number) => {
      mockTtl[key] = seconds
      return 1
    },
    ttl: async (key: string) => {
      return mockTtl[key] ?? -1
    },
  },
}))

const { createRateLimiter, rateLimiter, authRateLimiter, uploadRateLimiter } =
  await import('../rateLimiter')

import { Elysia } from 'elysia'

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> }
}

describe('rateLimiter middleware', () => {
  beforeEach(() => {
    mockStore = {}
    mockTtl = {}
  })

  describe('createRateLimiter factory', () => {
    it('allows requests within the limit', async () => {
      const limiter = createRateLimiter({
        maxRequests: 3,
        windowSeconds: 60,
        prefix: 'test',
        keyStrategy: 'ip',
      })

      const app = new Elysia()
        .use(limiter)
        .get('/test', () => ({ data: 'ok' }))

      const res = await app.handle(
        new Request('http://localhost/test', {
          headers: { 'x-forwarded-for': '192.168.1.1' },
        })
      )

      expect(res.status).toBe(200)
      expect(res.headers.get('X-RateLimit-Limit')).toBe('3')
      expect(res.headers.get('X-RateLimit-Remaining')).toBe('2')
    })

    it('returns 429 when limit is exceeded', async () => {
      const limiter = createRateLimiter({
        maxRequests: 2,
        windowSeconds: 60,
        prefix: 'test-exceed',
        keyStrategy: 'ip',
      })

      const app = new Elysia()
        .use(limiter)
        .get('/test', () => ({ data: 'ok' }))

      // Exhaust the limit
      await app.handle(
        new Request('http://localhost/test', {
          headers: { 'x-forwarded-for': '10.0.0.1' },
        })
      )
      await app.handle(
        new Request('http://localhost/test', {
          headers: { 'x-forwarded-for': '10.0.0.1' },
        })
      )

      // Third request should be rejected
      const res = await app.handle(
        new Request('http://localhost/test', {
          headers: { 'x-forwarded-for': '10.0.0.1' },
        })
      )

      expect(res.status).toBe(429)
      const body = (await res.json()) as ErrorBody
      expect(body.error.code).toBe('RATE_LIMIT_EXCEEDED')
      expect(res.headers.get('Retry-After')).toBe('60')
    })

    it('uses user_id as key when strategy is user and claims exist', async () => {
      const limiter = createRateLimiter({
        maxRequests: 5,
        windowSeconds: 60,
        prefix: 'user-test',
        keyStrategy: 'user',
      })

      const app = new Elysia()
        .derive(() => ({
          claims: {
            user_id: 'user-abc-123',
            company_id: 'company-xyz',
            soffice_id: 'soffice-001',
            role_label: 'SALESMAN' as const,
            lini_ids: [],
          },
        }))
        .use(limiter)
        .get('/test', () => ({ data: 'ok' }))

      await app.handle(new Request('http://localhost/test'))

      expect(mockStore['rl:user-test:u:user-abc-123']).toBe(1)
    })

    it('falls back to IP when claims are null for user strategy', async () => {
      const limiter = createRateLimiter({
        maxRequests: 5,
        windowSeconds: 60,
        prefix: 'fallback',
        keyStrategy: 'user',
      })

      const app = new Elysia()
        .derive(() => ({ claims: null }))
        .use(limiter)
        .get('/test', () => ({ data: 'ok' }))

      await app.handle(
        new Request('http://localhost/test', {
          headers: { 'x-forwarded-for': '1.2.3.4' },
        })
      )

      expect(mockStore['rl:fallback:u:1.2.3.4']).toBe(1)
    })

    it('uses company_id for tenant strategy', async () => {
      const limiter = createRateLimiter({
        maxRequests: 100,
        windowSeconds: 60,
        prefix: 'tenant-test',
        keyStrategy: 'tenant',
      })

      const app = new Elysia()
        .derive(() => ({
          claims: {
            user_id: 'user-1',
            company_id: 'tenant-abc',
            soffice_id: 'soffice-1',
            role_label: 'ADMIN_PUSAT' as const,
            lini_ids: [],
          },
        }))
        .use(limiter)
        .get('/test', () => ({ data: 'ok' }))

      await app.handle(new Request('http://localhost/test'))

      expect(mockStore['rl:tenant-test:t:tenant-abc']).toBe(1)
    })

    it('includes retry_after in error details', async () => {
      const limiter = createRateLimiter({
        maxRequests: 1,
        windowSeconds: 45,
        prefix: 'retry-test',
        keyStrategy: 'ip',
      })

      const app = new Elysia()
        .use(limiter)
        .get('/test', () => ({ data: 'ok' }))

      const ip = '5.5.5.5'
      await app.handle(
        new Request('http://localhost/test', {
          headers: { 'x-forwarded-for': ip },
        })
      )

      const res = await app.handle(
        new Request('http://localhost/test', {
          headers: { 'x-forwarded-for': ip },
        })
      )

      expect(res.status).toBe(429)
      const body = (await res.json()) as ErrorBody
      expect(body.error.details?.limit).toBe(1)
      expect(body.error.details?.window_seconds).toBe(45)
      expect(body.error.details?.retry_after).toBe(45)
    })
  })

  describe('default rateLimiter (100/min user + 1000/min tenant)', () => {
    it('allows authenticated requests within limit', async () => {
      const app = new Elysia()
        .derive(() => ({
          claims: {
            user_id: 'uid-default-test',
            company_id: 'cid-default-test',
            soffice_id: 'sid-1',
            role_label: 'SALESMAN' as const,
            lini_ids: [],
          },
        }))
        .use(rateLimiter)
        .get('/api', () => ({ data: 'ok' }))

      const res = await app.handle(new Request('http://localhost/api'))

      expect(res.status).toBe(200)
      expect(res.headers.get('X-RateLimit-Limit')).toBe('100')
      expect(res.headers.get('X-RateLimit-Remaining')).toBe('99')
    })

    it('allows unauthenticated requests with IP fallback', async () => {
      const app = new Elysia()
        .derive(() => ({ claims: null }))
        .use(rateLimiter)
        .get('/public', () => ({ data: 'public' }))

      const res = await app.handle(
        new Request('http://localhost/public', {
          headers: { 'x-forwarded-for': '9.9.9.9' },
        })
      )

      expect(res.status).toBe(200)
      expect(mockStore['rl:default:u:9.9.9.9']).toBe(1)
    })
  })

  describe('authRateLimiter (5/min per IP)', () => {
    it('blocks after 5 attempts from same IP', async () => {
      const app = new Elysia()
        .use(authRateLimiter)
        .post('/auth/login', () => ({ data: 'logged in' }))

      const makeRequest = () =>
        app.handle(
          new Request('http://localhost/auth/login', {
            method: 'POST',
            headers: {
              'x-forwarded-for': '172.16.0.1',
              'content-type': 'application/json',
            },
            body: JSON.stringify({ email: 'a@b.com', password: 'x' }),
          })
        )

      // 5 allowed
      for (let i = 0; i < 5; i++) {
        const res = await makeRequest()
        expect(res.status).toBe(200)
      }

      // 6th blocked
      const blocked = await makeRequest()
      expect(blocked.status).toBe(429)
      const body = (await blocked.json()) as ErrorBody
      expect(body.error.code).toBe('RATE_LIMIT_EXCEEDED')
    })
  })

  describe('uploadRateLimiter (30/min per user)', () => {
    it('uses user key strategy for upload limiting', async () => {
      const app = new Elysia()
        .derive(() => ({
          claims: {
            user_id: 'upload-user-1',
            company_id: 'company-1',
            soffice_id: 'soffice-1',
            role_label: 'SALESMAN' as const,
            lini_ids: [],
          },
        }))
        .use(uploadRateLimiter)
        .post('/uploads/presigned-url', () => ({ data: 'url' }))

      const res = await app.handle(
        new Request('http://localhost/uploads/presigned-url', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ category: 'attendance', content_type: 'image/jpeg', extension: 'jpg' }),
        })
      )

      expect(res.status).toBe(200)
      expect(mockStore['rl:upload:u:upload-user-1']).toBe(1)
    })
  })

  describe('IP extraction', () => {
    it('extracts IP from x-forwarded-for with multiple proxies', async () => {
      const limiter = createRateLimiter({
        maxRequests: 10,
        windowSeconds: 60,
        prefix: 'ip-extract',
        keyStrategy: 'ip',
      })

      const app = new Elysia()
        .use(limiter)
        .get('/test', () => ({ data: 'ok' }))

      await app.handle(
        new Request('http://localhost/test', {
          headers: { 'x-forwarded-for': '203.0.113.50, 70.41.3.18, 150.172.238.178' },
        })
      )

      expect(mockStore['rl:ip-extract:ip:203.0.113.50']).toBe(1)
    })

    it('falls back to x-real-ip header', async () => {
      const limiter = createRateLimiter({
        maxRequests: 10,
        windowSeconds: 60,
        prefix: 'real-ip',
        keyStrategy: 'ip',
      })

      const app = new Elysia()
        .use(limiter)
        .get('/test', () => ({ data: 'ok' }))

      await app.handle(
        new Request('http://localhost/test', {
          headers: { 'x-real-ip': '198.51.100.1' },
        })
      )

      expect(mockStore['rl:real-ip:ip:198.51.100.1']).toBe(1)
    })
  })
})
