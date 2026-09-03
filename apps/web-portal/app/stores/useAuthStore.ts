/**
 * `useAuthStore` — authentication state for the Web Portal (admin roles).
 *
 * Minimal, login-focused session store for the desktop admin portal. It owns:
 *  - The opaque JWT bearer token and the decoded profile derived from its claims
 *    (`user_id`, `company_id`, `soffice_id`, `role_label`, `lini_ids`, `iat`, `exp`).
 *  - Authentication lifecycle: {@link login} (`POST /auth/login`) and {@link logout}
 *    (`POST /auth/logout`, best-effort).
 *  - Session hydration on launch ({@link hydrate}) — restore token + profile from
 *    client storage so a valid, unexpired token counts as authenticated.
 *  - Token persistence to localStorage (SSR-guarded), so subsequent API calls attach it.
 *  - Expiry awareness: an expired token is treated as unauthenticated.
 *
 * Scoped intentionally to what the login flow needs — the full API client
 * (`useApiClient`), tenant, and reporting composables are separate Phase 13 tasks.
 * Auth calls are online-only: credentials are never queued. The raw password is
 * never stored or persisted.
 */
import { computed, ref, type Ref } from 'vue'
import { defineStore } from 'pinia'
import { UserRole } from '@maction/types'

/** localStorage key holding the opaque JWT bearer token for the admin user. */
export const AUTH_TOKEN_STORAGE_KEY = 'maction_admin_auth_token'

/** localStorage key holding the decoded profile snapshot for hydration. */
export const AUTH_PROFILE_STORAGE_KEY = 'maction_admin_auth_profile'

/** Fallback base URL when Nuxt runtimeConfig is not resolvable (tests, non-Nuxt contexts). */
const FALLBACK_BASE_URL = '/api'

/** Decoded JWT claims issued by the backend `POST /auth/login`. */
export interface AuthTokenClaims {
  user_id: string
  company_id: string
  soffice_id: string
  role_label: UserRole
  /** Business-line UUIDs the user is assigned to. */
  lini_ids: string[]
  /** Issued-at, seconds since epoch. */
  iat: number
  /** Expiry, seconds since epoch. */
  exp: number
}

/** The authenticated user profile the portal consumes (claims minus JWT timing fields). */
export interface AuthProfile {
  user_id: string
  company_id: string
  soffice_id: string
  role_label: UserRole
  lini_ids: string[]
}

/** Credentials accepted by {@link login}. */
export interface LoginCredentials {
  email: string
  password: string
}

/** Backend success payload for `POST /auth/login`. */
interface AuthLoginData {
  token: string
}

/**
 * Online-only transport for auth endpoints. Satisfied by Nuxt `$fetch` at runtime
 * and by a mock in tests.
 */
export type AuthTransport = <T>(
  path: string,
  init: { method: string, body?: Record<string, unknown>, headers?: Record<string, string> }
) => Promise<T>

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

/** Project decoded claims into the leaner profile the portal consumes. */
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
  const transport: AuthTransport = createDefaultTransport(resolveBaseUrl())

  /** Whether the current token exists and has not expired. */
  const isAuthenticated = computed<boolean>(
    () => token.value !== null && profile.value !== null && expiresAt.value > 0 && !isExpired(expiresAt.value)
  )

  const role = computed<UserRole | null>(() => profile.value?.role_label ?? null)
  const roleLabel = computed<UserRole | null>(() => profile.value?.role_label ?? null)
  const liniIds = computed<string[]>(() => profile.value?.lini_ids ?? [])
  const companyId = computed<string | null>(() => profile.value?.company_id ?? null)
  const userId = computed<string | null>(() => profile.value?.user_id ?? null)
  const sofficeId = computed<string | null>(() => profile.value?.soffice_id ?? null)
  const isSuperAdmin = computed<boolean>(() => role.value === UserRole.SUPER_ADMIN)

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
    roleLabel,
    liniIds,
    companyId,
    userId,
    sofficeId,
    isSuperAdmin,
    login,
    logout,
    hydrate
  }
})
