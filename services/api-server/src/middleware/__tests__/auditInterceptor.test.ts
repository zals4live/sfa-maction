import { describe, it, expect } from 'bun:test'

import { resolveClientIp, isSuccessfulMutation } from '../auditInterceptor'

describe('auditInterceptor helpers', () => {
  describe('resolveClientIp', () => {
    it('prefers the first entry of x-forwarded-for', () => {
      expect(
        resolveClientIp({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }),
      ).toBe('203.0.113.7')
    })

    it('trims whitespace around the forwarded IP', () => {
      expect(resolveClientIp({ 'x-forwarded-for': '  198.51.100.2 ' })).toBe('198.51.100.2')
    })

    it('falls back to x-real-ip when no forwarded header exists', () => {
      expect(resolveClientIp({ 'x-real-ip': '192.0.2.5' })).toBe('192.0.2.5')
    })

    it('returns null when no IP headers are present', () => {
      expect(resolveClientIp({})).toBeNull()
    })
  })

  describe('isSuccessfulMutation', () => {
    it('accepts 2xx responses on mutating methods', () => {
      expect(isSuccessfulMutation('POST', 201)).toBe(true)
      expect(isSuccessfulMutation('patch', 200)).toBe(true)
      expect(isSuccessfulMutation('PUT', 200)).toBe(true)
      expect(isSuccessfulMutation('DELETE', 204)).toBe(true)
    })

    it('rejects non-mutating methods', () => {
      expect(isSuccessfulMutation('GET', 200)).toBe(false)
      expect(isSuccessfulMutation('HEAD', 200)).toBe(false)
    })

    it('rejects non-2xx responses', () => {
      expect(isSuccessfulMutation('POST', 403)).toBe(false)
      expect(isSuccessfulMutation('POST', 500)).toBe(false)
      expect(isSuccessfulMutation('DELETE', 404)).toBe(false)
    })
  })
})
