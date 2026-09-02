/**
 * `useApiClient` — centralized HTTP client for the Field PWA with offline fallback.
 *
 * The single API abstraction shared by both SALESMAN and MR field roles. It owns:
 *  - Base URL resolution from Nuxt `runtimeConfig` (`public.apiBase`), degrading to a
 *    relative `/api` prefix when config is unavailable (SSR-less unit tests, previews).
 *  - JWT attachment: the bearer token is read from an injectable auth source (the Pinia
 *    `useAuthStore` once it lands, or encrypted local storage), so this composable never
 *    hard-depends on a store that may not exist yet.
 *  - Reactive connectivity state (ONLINE / OFFLINE / SYNCING) surfaced for the navbar.
 *  - Online reads/writes via `$fetch`, mapping the backend error contract
 *    (`{ error: { code, message, details } }`) into a typed {@link ApiError}, never
 *    leaking raw internals.
 *  - Offline GET: fall back to a caller-supplied cached resolver (typically a
 *    {@link useOfflineDb} lookup) instead of throwing.
 *  - Offline mutations (POST/PUT/PATCH/DELETE): enqueue a `LocalOutboxMutation` to the
 *    outbox via {@link useBackgroundSync} (carrying the capturing `user_role`) and return
 *    an optimistic queued result rather than failing hard.
 *
 * Binary/photo uploads MUST NOT flow through this client — they use S3 pre-signed URLs.
 */
import { readonly, ref, type Ref } from 'vue'
import type {
  ConnectivityState,
  MutationType,
  UserRole
} from '@maction/types'
import {
  useBackgroundSync,
  type BackgroundSyncApi,
  type OutboxDraft
} from './useBackgroundSync'

/** HTTP methods that mutate server state and are safe to queue offline. */
export type MutationMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** Structured error mirroring the backend API error contract. */
export interface ApiErrorPayload {
  code: string
  message: string
  details?: Record<string, unknown>
}

/**
 * Typed error thrown for online request failures. Wraps the backend `{ error }` contract
 * so callers can branch on `code` without inspecting raw responses or stack traces.
 */
export class ApiError extends Error {
  readonly code: string
  readonly status: number
  readonly details?: Record<string, unknown>

  constructor(payload: ApiErrorPayload, status: number) {
    super(payload.message)
    this.name = 'ApiError'
    this.code = payload.code
    this.status = status
    this.details = payload.details
  }
}

/** Identity of the capturing user — required to enqueue role-adaptive offline mutations. */
export interface RequestIdentity {
  company_id: string
  user_id: string
  user_role: UserRole
}

/** Options common to every request. */
export interface RequestOptions {
  /** Query string parameters (GET). */
  query?: Record<string, unknown>
  /** Request body (mutations); must be JSON-serializable — never binary. */
  body?: Record<string, unknown>
  /** Extra headers merged over the defaults (Authorization is added automatically). */
  headers?: Record<string, string>
}

/** GET-specific options: a cached resolver used when offline. */
export interface GetOptions<T> extends RequestOptions {
  /** Resolve a cached value (e.g. a Dexie lookup) when the device is offline. */
  offlineFallback?: () => Promise<T> | T
}

/** Mutation-specific options controlling how an offline request is queued. */
export interface MutationOptions extends RequestOptions {
  /** Identity used to stamp the outbox mutation with the capturing user + role. */
  identity: RequestIdentity
  /** Semantic mutation type recorded in the outbox (drives role-adaptive sync). */
  mutationType: MutationType
  /** Stable id for the queued mutation; a UUID is generated when omitted. */
  mutationId?: string
  /** Monotonic-clock delta captured at the call site (anti-spoof). Defaults to 0. */
  monoDeltaMs?: number
}

/** Result of a mutation performed while offline — the queued outbox handle. */
export interface QueuedMutationResult {
  queued: true
  mutationId: string
}

/** Provider of the current auth bearer token; async to allow storage decryption. */
export type TokenProvider = () => string | null | undefined | Promise<string | null | undefined>

/**
 * Minimal transport contract — satisfied by Nuxt `$fetch` or a test mock. Non-generic so
 * mocks are trivially assignable; `request<T>` narrows the returned value at the call site.
 */
export type ApiFetch = (url: string, init: ApiFetchInit) => Promise<unknown>

/** Low-level fetch init passed to the transport. */
export interface ApiFetchInit {
  method: string
  query?: Record<string, unknown>
  body?: Record<string, unknown>
  headers: Record<string, string>
}

/** Options for {@link useApiClient}; all optional so runtime and tests can diverge. */
export interface ApiClientOptions {
  /** Override the base URL (defaults to `runtimeConfig.public.apiBase`, else `/api`). */
  baseUrl?: string
  /** Supply the auth bearer token (defaults to reading `maction_auth_token` from storage). */
  getToken?: TokenProvider
  /** Override the network transport (tests inject a mock; runtime falls back to `$fetch`). */
  fetcher?: ApiFetch
  /** Override the background-sync layer used to queue offline mutations. */
  sync?: BackgroundSyncApi
}

/** Public surface returned by {@link useApiClient}. */
export interface ApiClientApi {
  connectivity: Readonly<Ref<ConnectivityState>>
  get: <T>(path: string, options?: GetOptions<T>) => Promise<T>
  post: <T>(path: string, options: MutationOptions) => Promise<T | QueuedMutationResult>
  put: <T>(path: string, options: MutationOptions) => Promise<T | QueuedMutationResult>
  patch: <T>(path: string, options: MutationOptions) => Promise<T | QueuedMutationResult>
  delete: <T>(path: string, options: MutationOptions) => Promise<T | QueuedMutationResult>
}

/** Local-storage key holding the encrypted/opaque JWT for the field user. */
export const AUTH_TOKEN_STORAGE_KEY = 'maction_auth_token'

/** Fallback base URL when Nuxt runtimeConfig is not resolvable (tests, non-Nuxt contexts). */
const FALLBACK_BASE_URL = '/api'

/** Resolve the API base URL from Nuxt runtimeConfig, degrading gracefully off-Nuxt. */
function resolveBaseUrl(explicit?: string): string {
  if (explicit) return explicit
  const runtime = tryUseRuntimeConfig()
  const configured = runtime?.public?.apiBase
  return typeof configured === 'string' && configured.length > 0 ? configured : FALLBACK_BASE_URL
}

/** Read Nuxt runtimeConfig if the auto-import exists; never throw outside a Nuxt context. */
function tryUseRuntimeConfig(): { public?: { apiBase?: string } } | undefined {
  const globalHook = (globalThis as { useRuntimeConfig?: () => { public?: { apiBase?: string } } })
    .useRuntimeConfig
  try {
    return typeof globalHook === 'function' ? globalHook() : undefined
  } catch {
    return undefined
  }
}

/** Default token provider: read the opaque JWT from local storage when available. */
const defaultTokenProvider: TokenProvider = () => {
  if (typeof localStorage === 'undefined') return null
  return localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)
}

/** Default transport: Nuxt `$fetch` (ofetch) when no client is injected. */
const defaultFetcher: ApiFetch = (url: string, init: ApiFetchInit): Promise<unknown> =>
  ($fetch as unknown as ApiFetch)(url, init)

/** Join the base URL and a request path without duplicating the boundary slash. */
function joinUrl(baseUrl: string, path: string): string {
  const trimmedBase = baseUrl.replace(/\/+$/, '')
  const trimmedPath = path.replace(/^\/+/, '')
  return `${trimmedBase}/${trimmedPath}`
}

/** Generate a stable mutation id, preferring the platform `crypto.randomUUID`. */
function generateMutationId(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID()
  return `mut-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

/** Coerce an unknown thrown value into a typed {@link ApiError} without leaking internals. */
function toApiError(err: unknown): ApiError {
  const data = (err as { data?: { error?: Partial<ApiErrorPayload> } })?.data
  const status = (err as { status?: number, statusCode?: number })?.status
    ?? (err as { statusCode?: number })?.statusCode
    ?? 0
  const payload = data?.error
  if (payload?.code && payload?.message) {
    return new ApiError({ code: payload.code, message: payload.message, details: payload.details }, status)
  }
  return new ApiError({ code: 'REQUEST_FAILED', message: 'The request could not be completed.' }, status)
}

export function useApiClient(options: ApiClientOptions = {}): ApiClientApi {
  const baseUrl = resolveBaseUrl(options.baseUrl)
  const getToken = options.getToken ?? defaultTokenProvider
  const fetcher = options.fetcher ?? defaultFetcher
  const sync = options.sync ?? useBackgroundSync()

  const connectivity = ref<ConnectivityState>('ONLINE')

  const isOnline = (): boolean =>
    typeof navigator === 'undefined' ? true : navigator.onLine !== false

  /** Build request headers, attaching the bearer token when one is available. */
  async function buildHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extra }
    const token = await getToken()
    if (token) headers.Authorization = `Bearer ${token}`
    return headers
  }

  /** Perform an online request, mapping transport/HTTP failures into an {@link ApiError}. */
  async function request<T>(method: string, path: string, options: RequestOptions): Promise<T> {
    connectivity.value = 'SYNCING'
    const headers = await buildHeaders(options.headers)
    try {
      const result = await fetcher(joinUrl(baseUrl, path), {
        method,
        query: options.query,
        body: options.body,
        headers
      })
      connectivity.value = 'ONLINE'
      return result as T
    } catch (err) {
      connectivity.value = isOnline() ? 'ONLINE' : 'OFFLINE'
      throw toApiError(err)
    }
  }

  /** GET a resource; fall back to the caller's cached resolver when offline. */
  async function get<T>(path: string, options: GetOptions<T> = {}): Promise<T> {
    if (!isOnline()) {
      connectivity.value = 'OFFLINE'
      if (options.offlineFallback) return options.offlineFallback()
      throw new ApiError({ code: 'OFFLINE_NO_CACHE', message: 'You are offline and no cached data is available.' }, 0)
    }
    return request<T>('GET', path, options)
  }

  /** Enqueue a mutation to the outbox and return an optimistic queued handle. */
  async function queueMutation(
    method: MutationMethod,
    path: string,
    options: MutationOptions
  ): Promise<QueuedMutationResult> {
    connectivity.value = 'OFFLINE'
    const mutationId = options.mutationId ?? generateMutationId()
    const draft: OutboxDraft = {
      id: mutationId,
      company_id: options.identity.company_id,
      user_id: options.identity.user_id,
      user_role: options.identity.user_role,
      mutation_type: options.mutationType,
      endpoint: joinUrl(baseUrl, path),
      http_method: method,
      payload: options.body ?? {},
      mono_delta_ms: options.monoDeltaMs ?? 0
    }
    await sync.enqueue(draft)
    return { queued: true, mutationId }
  }

  /** Perform a mutation online, or queue it to the outbox when offline. */
  function mutate<T>(
    method: MutationMethod,
    path: string,
    options: MutationOptions
  ): Promise<T | QueuedMutationResult> {
    if (!isOnline()) return queueMutation(method, path, options)
    return request<T>(method, path, options)
  }

  return {
    connectivity: readonly(connectivity),
    get,
    post: <T>(path: string, options: MutationOptions) => mutate<T>('POST', path, options),
    put: <T>(path: string, options: MutationOptions) => mutate<T>('PUT', path, options),
    patch: <T>(path: string, options: MutationOptions) => mutate<T>('PATCH', path, options),
    delete: <T>(path: string, options: MutationOptions) => mutate<T>('DELETE', path, options)
  }
}
