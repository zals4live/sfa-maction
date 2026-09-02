/**
 * `useAuthStore` — authentication state for the Field PWA (SALESMAN & MR).
 *
 * The single source of truth for the field user's session. It owns:
 *  - The opaque JWT bearer token and the decoded profile derived from its claims
 *    (`user_id`, `company_id`, `soffice_id`, `role_label`, `lini_ids`, `iat`, `exp`).
 *  - Authentication lifecycle: {@link AuthStoreApi.login} (`POST /auth/login`),
 *    {@link AuthStoreApi.logout} (`POST /auth/logout`), and {@link AuthStoreApi.fetchProfile}
 *    (`GET /auth/me`).
 *  - Session hydration on app launch ({@link AuthStoreApi.hydrate}) — restore token +
 *    profile from client-side storage so a valid, unexpired token counts as authenticated
 *    *offline*, with no network round-trip required.
 *  - Token persistence to a PWA-appropriate client store (localStorage, guarded for SSR).
 *    The token is written under the same key the API client reads
 *    ({@link AUTH_TOKEN_STORAGE_KEY}), so authenticated requests attach it automatically.
 *  - Expiry awareness: an expired token is treated as unauthenticated.
 *
 * Auth calls are deliberately online-only: credentials must never be queued into the
 * offline outbox, so this store talks to an injectable {@link AuthTransport} rather than
 * the mutation-queuing `useApiClient.post`. Getters ({@link AuthStoreApi.role},
 * {@link AuthStoreApi.liniIds}, ...) expose the decoded claims so `useRoleGuard` and pages
 * read role/tenant context without decoding tokens themselves. The raw password is never
 * stored or persisted.
 */
import { computed, ref, type Ref } from 'vue'
import { defineStore } from 'pinia'
import { UserRole } from '@maction/types'
import { AUTH_TOKEN_STORAGE_KEY } from '../composables/useApiClient'

/** Storage key holding the decoded profile snapshot for offline hydration. */
export const AUTH_PROFILE_STORAGE_KEY = 'maction_auth_profile'

/** Decoded JWT claims issued by the backend `POST /auth/login`. */
export interface AuthTokenClaims {
  user_id: string
  company_id: string
  soffice_id: string
  role_label: UserRole
  /** Business-line UUIDs the field user is assigned to (drives lini-scoped material access). */
  lini_ids: string[]
  /** Issued-at, seconds since epoch. */
  iat: number
  /** Expiry, seconds since epoch. */
  exp: number
}

/** The authenticated user profile the app consumes (claims minus JWT timing fields). */
export interface AuthProfile {
  user_id: string
  company_id: string
  soffice_id: string
  role_label: UserRole
  lini_ids: string[]
}

/** Credentials accepted by {@link AuthStoreApi.login}. */
export interface LoginCredentials {
  email: string
  password: string
}

/** Backend success payload for `POST /auth/login`. */
interface AuthLoginData {
  token: string
}

/**
 * Online-only transport for auth endpoints. Kept separate from `useApiClient.post` so
 * credentials are never enqueued to the offline outbox. Satisfied by Nuxt `$fetch` at
 * runtime and by a mock in tests.
 */
export type AuthTransport = <T>(
  path: string,
  init: { method: string, body?: Record<string, unknown>, headers?: Record<string, string> }
) => Promise<T>

/** Fallback base URL when Nuxt runtimeConfig is not resolvable (tests, non-Nuxt contexts). */
const FALLBACK_BASE_URL = '/api'

/** Decode a JWT payload segment into typed claims, or `null` when malformed. */
export function decodeTokenClaims(token: string): AuthTokenClaims | null {
  const segment = token.split('.')[1]
  if (!segment) return null
  const json = decodeBase64Url(segment)
  if (json === null) return null
  return parseClaims(json)
}

/** Base64URL-decode a JWT segment to its UTF-8 JSON string, tolerant of runtime gaps. */
function decodeBase64Url(segment: string): string | null {
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/')
  try {
    const decoder = (globalThis as { atob?: (data: string) => string }).atob
    if (typeof decoder === 'function') return decodeUtf8(decoder(normalized))
    const bufferCtor = (globalThis as {
      Buffer?: { from: (s: string, e: string) => { toString: (e: string) => string } }
    }).Buffer
    return bufferCtor ? bufferCtor.from(normalized, 'base64').toString('utf-8') : null
  } catch {
    return null
  }
}

/** Convert a binary-string (from `atob`) into a proper UTF-8 string when possible. */
function decodeUtf8(binary: string): string {
  const decoderCtor = (globalThis as {
    TextDecoder?: new () => { decode: (b: Uint8Array) => string }
  }).TextDecoder
  if (!decoderCtor) return binary
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
  return new decoderCtor().decode(bytes)
}

/** Parse a JSON claims string, validating the required shape before trusting it. */
function parseClaims(json: string): AuthTokenClaims | null {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const claims = raw as Record<string, unknown>
  if (typeof claims.user_id !== 'string' || typeof claims.company_id !== 'string') return null
  if (typeof claims.exp !== 'number') return null
  return {
    user_id: claims.user_id,
    company_id: claims.company_id,
    soffice_id: typeof claims.soffice_id === 'string' ? claims.soffice_id : '',
    role_label: claims.role_label as UserRole,
    lini_ids: Array.isArray(claims.lini_ids) ? (claims.lini_ids as string[]) : [],
    iat: typeof claims.iat === 'number' ? claims.iat : 0,
    exp: claims.exp
  }
}

/** Whether an expiry timestamp (seconds since epoch) is at or before `nowMs`. */
export function isExpired(exp: number, nowMs: number = Date.now()): boolean {
  return exp * 1000 <= nowMs
}

/** Project decoded claims into the leaner profile the app consumes. */
function claimsToProfile(claims: AuthTokenClaims): AuthProfile {
  return {
    user_id: claims.user_id,
    company_id: claims.company_id,
    soffice_id: claims.soffice_id,
    role_label: claims.role_label,
    lini_ids: claims.lini_ids
  }
}

/** Whether client-side storage is reachable (guards SSR and locked-down runtimes). */
function hasStorage(): boolean {
  return typeof localStorage !== 'undefined'
}

/** Persist token + profile to client storage; no-op under SSR. */
function writePersistedSession(token: string, profile: AuthProfile): void {
  if (!hasStorage()) return
  localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token)
  localStorage.setItem(AUTH_PROFILE_STORAGE_KEY, JSON.stringify(profile))
}

/** Clear any persisted session; no-op under SSR. */
function clearPersistedSession(): void {
  if (!hasStorage()) return
  localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY)
  localStorage.removeItem(AUTH_PROFILE_STORAGE_KEY)
}

/** Read a persisted token from client storage, or `null`. */
function readPersistedToken(): string | null {
  return hasStorage() ? localStorage.getItem(AUTH_TOKEN_STORAGE_KEY) : null
}

/** Resolve the API base URL from Nuxt runtimeConfig, degrading gracefully off-Nuxt. */
function resolveBaseUrl(explicit?: string): string {
  if (explicit) return explicit
  const globalHook = (
    globalThis as { useRuntimeConfig?: () => { public?: { apiBase?: string } } }
  ).useRuntimeConfig
  try {
    const configured = typeof globalHook === 'function' ? globalHook()?.public?.apiBase : undefined
    return typeof configured === 'string' && configured.length > 0 ? configured : FALLBACK_BASE_URL
  } catch {
    return FALLBACK_BASE_URL
  }
}

/** Join the base URL and a request path without duplicating the boundary slash. */
function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

/** Build the default online-only transport bound to `$fetch` and the resolved base URL. */
function createDefaultTransport(baseUrl: string): AuthTransport {
  return <T>(path: string, init: { method: string, body?: Record<string, unknown>, headers?: Record<string, string> }) => {
    const token = readPersistedToken()
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...init.headers }
    if (token) headers.Authorization = `Bearer ${token}`
    const fetcher = ($fetch as unknown) as (url: string, opts: unknown) => Promise<T>
    return fetcher(joinUrl(baseUrl, path), { method: init.method, body: init.body, headers })
  }
}

export const useAuthStore = defineStore('auth', () => {
  const token: Ref<string | null> = ref(null)
  const profile: Ref<AuthProfile | null> = ref(null)
  const expiresAt: Ref<number> = ref(0)

  // The transport is bound once per store instance from the resolved runtime base URL.
  // It reads `$fetch` off globalThis at call time, so tests stub the global to intercept.
  const transport: AuthTransport = createDefaultTransport(resolveBaseUrl())

  /** Whether the current token exists and has not expired. */
  const isAuthenticated = computed<boolean>(
    () => token.value !== null && profile.value !== null && expiresAt.value > 0 && !isExpired(expiresAt.value)
  )

  const role = computed<UserRole | null>(() => profile.value?.role_label ?? null)
  const liniIds = computed<string[]>(() => profile.value?.lini_ids ?? [])
  const companyId = computed<string | null>(() => profile.value?.company_id ?? null)
  const userId = computed<string | null>(() => profile.value?.user_id ?? null)
  const sofficeId = computed<string | null>(() => profile.value?.soffice_id ?? null)
  const isSalesman = computed<boolean>(() => role.value === UserRole.SALESMAN)
  const isMr = computed<boolean>(() => role.value === UserRole.MR)

  /** Adopt a token: decode, apply to state, and persist. Returns false when malformed/expired. */
  function applyToken(nextToken: string): boolean {
    const claims = decodeTokenClaims(nextToken)
    if (!claims || isExpired(claims.exp)) return false
    token.value = nextToken
    profile.value = claimsToProfile(claims)
    expiresAt.value = claims.exp
    writePersistedSession(nextToken, profile.value)
    return true
  }

  /** Reset all in-memory state and drop the persisted session. */
  function resetState(): void {
    token.value = null
    profile.value = null
    expiresAt.value = 0
    clearPersistedSession()
  }

  /** Authenticate against `POST /auth/login`, persisting the returned token + profile. */
  async function login(credentials: LoginCredentials): Promise<AuthProfile> {
    const response = await transport<{ data: AuthLoginData }>('/auth/login', {
      method: 'POST',
      body: { email: credentials.email, password: credentials.password }
    })
    const nextToken = response?.data?.token
    if (!nextToken || !applyToken(nextToken)) {
      throw new Error('Login failed: the server did not return a valid session token.')
    }
    return profile.value as AuthProfile
  }

  /** Notify `POST /auth/logout` (best-effort) then clear all local session state. */
  async function logout(): Promise<void> {
    if (token.value) {
      try {
        await transport('/auth/logout', { method: 'POST', body: {} })
      } catch {
        // Logout is best-effort — always clear local state even if the network call fails.
      }
    }
    resetState()
  }

  /** Refresh the profile from `GET /auth/me`; keeps the cached profile when offline/failing. */
  async function fetchProfile(): Promise<AuthProfile | null> {
    if (!token.value) return null
    try {
      const response = await transport<{ data: AuthProfile }>('/auth/me', { method: 'GET' })
      if (response?.data) profile.value = response.data
    } catch {
      // Offline or transient failure — fall back to the hydrated profile already in state.
    }
    return profile.value
  }

  /** Restore a session from client storage on launch; drops any expired/invalid token. */
  function hydrate(): boolean {
    const persisted = readPersistedToken()
    if (!persisted) return false
    if (!applyToken(persisted)) {
      resetState()
      return false
    }
    return true
  }

  return {
    token,
    profile,
    expiresAt,
    isAuthenticated,
    role,
    liniIds,
    companyId,
    userId,
    sofficeId,
    isSalesman,
    isMr,
    login,
    logout,
    fetchProfile,
    hydrate
  }
})
