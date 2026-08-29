import { describe, it, expect, mock, beforeEach } from 'bun:test'

const mockSql = mock(() => Promise.resolve([{ '?column?': 1 }]))
const mockPing = mock(() => Promise.resolve('PONG'))

mock.module('../../../config/database', () => ({
  sql: Object.assign(mockSql, {
    unsafe: mock(() => Promise.resolve([])),
  }),
}))

mock.module('../../../config/redis', () => ({
  redis: { ping: mockPing },
}))

const { checkDatabaseHealth, checkRedisHealth } = await import('../service')

describe('health/service', () => {
  beforeEach(() => {
    mockSql.mockClear()
    mockPing.mockClear()
  })

  describe('checkDatabaseHealth', () => {
    it('should return up with latency when database responds', async () => {
      mockSql.mockResolvedValueOnce([{ '?column?': 1 }])
      const result = await checkDatabaseHealth()
      expect(result.status).toBe('up')
      expect(result.latency_ms).toBeGreaterThanOrEqual(0)
    })

    it('should return down when database throws', async () => {
      mockSql.mockRejectedValueOnce(new Error('connection refused'))
      const result = await checkDatabaseHealth()
      expect(result.status).toBe('down')
      expect(result.latency_ms).toBeGreaterThanOrEqual(0)
    })
  })

  describe('checkRedisHealth', () => {
    it('should return up with latency when redis responds', async () => {
      mockPing.mockResolvedValueOnce('PONG')
      const result = await checkRedisHealth()
      expect(result.status).toBe('up')
      expect(result.latency_ms).toBeGreaterThanOrEqual(0)
    })

    it('should return down when redis throws', async () => {
      mockPing.mockRejectedValueOnce(new Error('connection refused'))
      const result = await checkRedisHealth()
      expect(result.status).toBe('down')
      expect(result.latency_ms).toBeGreaterThanOrEqual(0)
    })
  })
})
