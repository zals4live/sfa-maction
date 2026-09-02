import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { UserRole } from '@maction/types'
import { AUTH_TOKEN_STORAGE_KEY } from '../../composables/useApiClient'
import {
  AUTH_PROFILE_STORAGE_KEY,
  decodeTokenClaims,
  isExpired,
  useAuthStore,
  type AuthTokenClaims
} from '../useAuthStore'

/** Shape of the fetch init the auth transport passes to the stubbed `$fetch`. */
interface FetchInit {
  method: string
  body?: Record<string, unknown>
  headers?: Record<string, string>
}

/** Base64URL-encode a UTF-8 string (test-side JWT builder — mirrors the decode path). */
function base64Url(input: string): string {
  const base64 = Buffer.from(input, 'utf-8').toString('base64')
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Build a signed-looking JWT (header.payload.signature) carrying the given claims. */
function makeToken(claims: Partial<AuthTokenClaims> = {}): string {
  const nowSec = Math.floor(Date.now() / 1000)
  const payload: AuthTokenClaims = {
    user_id: 'user-1',
    company_id: 'company-a',
    soffice_id: 'soffice-1',
    role_label: UserRole.SALESMAN,
    lini_ids: ['lini-1', 'lini-2'],
    iat: nowSec,
    exp: nowSec + 3600,
    ...claims
  }
  return `${base64Url('{"alg":"HS256"}')}.${base64Url(JSON.stringify(payload))}.sig`
}

/** Install an in-memory localStorage shim; returns a restore fn. */
function installStorage(): { store: Map<string, string>, restore: () => void } {
  const store = new Map<string, string>()
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (k: string): string | null => store.get(k) ?? null,
      setItem: (k: string, v: string): void => void store.set(k, v),
      removeItem: (k: string): void => void store.delete(k)
    }
  })
  return {
    store,
    restore: () => {
      if (original) Object.defineProperty(globalThis, 'localStorage', original)
      else delete (globalThis as { localStorage?: unknown }).localStorage
    }
  }
}

describe('useAuthStore', () => {
  let storage: ReturnType<typeof installStorage>

  beforeEach(() => {
    setActivePinia(createPinia())
    storage = installStorage()
  })

  afterEach(() => {
    storage.restore()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  describe('token decoding helpers', () => {
    it('decodes the documented JWT claims including lini_ids', () => {
      const claims = decodeTokenClaims(makeToken())
      expect(claims).not.toBeNull()
      expect(claims?.user_id).toBe('user-1')
      expect(claims?.company_id).toBe('company-a')
      expect(claims?.soffice_id).toBe('soffice-1')
      expect(claims?.role_label).toBe(UserRole.SALESMAN)
      expect(claims?.lini_ids).toEqual(['lini-1', 'lini-2'])
    })

    it('returns null for a malformed token', () => {
      expect(decodeTokenClaims('not-a-jwt')).toBeNull()
    })

    it('treats a past expiry as expired', () => {
      const past = Math.floor(Date.now() / 1000) - 10
      expect(isExpired(past)).toBe(true)
      const future = Math.floor(Date.now() / 1000) + 10
      expect(isExpired(future)).toBe(false)
    })
  })

  describe('login', () => {
    it('stores the token + decoded profile and persists them', async () => {
      const token = makeToken()
      const fetchMock = vi.fn(async () => ({ data: { token } }))
      vi.stubGlobal('$fetch', fetchMock)

      const store = useAuthStore()
      const profile = await store.login({ email: 'a@b.com', password: 'secret' })

      expect(profile.role_label).toBe(UserRole.SALESMAN)
      expect(store.isAuthenticated).toBe(true)
      expect(store.role).toBe(UserRole.SALESMAN)
      expect(store.liniIds).toEqual(['lini-1', 'lini-2'])
      expect(store.companyId).toBe('company-a')
      expect(store.userId).toBe('user-1')
      expect(store.sofficeId).toBe('soffice-1')
      expect(storage.store.get(AUTH_TOKEN_STORAGE_KEY)).toBe(token)
      expect(storage.store.get(AUTH_PROFILE_STORAGE_KEY)).toBeTruthy()
    })

    it('never sends credentials through the offline outbox (online-only transport)', async () => {
      const fetchMock = vi.fn(async (_url: string, _init: FetchInit) => ({ data: { token: makeToken() } }))
      vi.stubGlobal('$fetch', fetchMock)

      const store = useAuthStore()
      await store.login({ email: 'a@b.com', password: 'secret' })

      const call = fetchMock.mock.calls[0]
      expect(call).toBeDefined()
      const [url, init] = call as [string, FetchInit]
      expect(String(url)).toContain('/auth/login')
      expect(init.method).toBe('POST')
      expect(init.body).toEqual({ email: 'a@b.com', password: 'secret' })
    })

    it('throws when the server returns no valid token', async () => {
      vi.stubGlobal('$fetch', vi.fn(async () => ({ data: {} })))
      const store = useAuthStore()
      await expect(store.login({ email: 'a@b.com', password: 'x' })).rejects.toThrow()
      expect(store.isAuthenticated).toBe(false)
    })
  })

  describe('getters reflect the MR role', () => {
    it('marks isMr and forbids salesman helpers', async () => {
      vi.stubGlobal('$fetch', vi.fn(async () => ({ data: { token: makeToken({ role_label: UserRole.MR }) } })))
      const store = useAuthStore()
      await store.login({ email: 'mr@b.com', password: 'x' })

      expect(store.isMr).toBe(true)
      expect(store.isSalesman).toBe(false)
      expect(store.role).toBe(UserRole.MR)
    })
  })

  describe('isAuthenticated reflects token validity', () => {
    it('is false for an expired token and clears state on hydrate', () => {
      const expiredSec = Math.floor(Date.now() / 1000) - 60
      const token = makeToken({ exp: expiredSec, iat: expiredSec - 3600 })
      storage.store.set(AUTH_TOKEN_STORAGE_KEY, token)

      const store = useAuthStore()
      const restored = store.hydrate()

      expect(restored).toBe(false)
      expect(store.isAuthenticated).toBe(false)
      expect(storage.store.has(AUTH_TOKEN_STORAGE_KEY)).toBe(false)
    })

    it('hydrates a valid persisted token offline without any network call', () => {
      const token = makeToken()
      storage.store.set(AUTH_TOKEN_STORAGE_KEY, token)
      const fetchMock = vi.fn()
      vi.stubGlobal('$fetch', fetchMock)

      const store = useAuthStore()
      const restored = store.hydrate()

      expect(restored).toBe(true)
      expect(store.isAuthenticated).toBe(true)
      expect(store.role).toBe(UserRole.SALESMAN)
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })

  describe('logout', () => {
    it('clears in-memory state and persisted storage', async () => {
      const fetchMock = vi.fn(async () => ({ data: { token: makeToken() } }))
      vi.stubGlobal('$fetch', fetchMock)

      const store = useAuthStore()
      await store.login({ email: 'a@b.com', password: 'x' })
      expect(store.isAuthenticated).toBe(true)

      await store.logout()

      expect(store.isAuthenticated).toBe(false)
      expect(store.role).toBeNull()
      expect(store.token).toBeNull()
      expect(storage.store.has(AUTH_TOKEN_STORAGE_KEY)).toBe(false)
      expect(storage.store.has(AUTH_PROFILE_STORAGE_KEY)).toBe(false)
    })

    it('clears local state even when the logout call fails', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ data: { token: makeToken() } })
        .mockRejectedValueOnce(new Error('network down'))
      vi.stubGlobal('$fetch', fetchMock)

      const store = useAuthStore()
      await store.login({ email: 'a@b.com', password: 'x' })
      await store.logout()

      expect(store.isAuthenticated).toBe(false)
      expect(store.token).toBeNull()
    })
  })

  describe('fetchProfile', () => {
    it('refreshes the profile from GET /auth/me', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ data: { token: makeToken() } })
        .mockResolvedValueOnce({
          data: {
            user_id: 'user-1',
            company_id: 'company-a',
            soffice_id: 'soffice-9',
            role_label: UserRole.SALESMAN,
            lini_ids: ['lini-3']
          }
        })
      vi.stubGlobal('$fetch', fetchMock)

      const store = useAuthStore()
      await store.login({ email: 'a@b.com', password: 'x' })
      const profile = await store.fetchProfile()

      expect(profile?.soffice_id).toBe('soffice-9')
      expect(store.liniIds).toEqual(['lini-3'])
    })

    it('keeps the hydrated profile when the network call fails offline', async () => {
      const token = makeToken()
      storage.store.set(AUTH_TOKEN_STORAGE_KEY, token)
      const fetchMock = vi.fn().mockRejectedValue(new Error('offline'))
      vi.stubGlobal('$fetch', fetchMock)

      const store = useAuthStore()
      store.hydrate()
      const profile = await store.fetchProfile()

      expect(profile?.role_label).toBe(UserRole.SALESMAN)
      expect(store.liniIds).toEqual(['lini-1', 'lini-2'])
    })

    it('returns null when there is no token', async () => {
      const store = useAuthStore()
      await expect(store.fetchProfile()).resolves.toBeNull()
    })
  })
})
