/**
 * `useApiClient` — centralized HTTP client for the Web Portal (admin, SSR).
 *
 * The single API abstraction shared by every admin page. Unlike the Field PWA client,
 * the web-portal is server-rendered and always online, so this client has NO offline
 * fallback, NO outbox/background-sync, and NO Dexie. It owns:
 *  - Base URL resolution from Nuxt `runtimeConfig` (`public.apiBase`), degrading to a
 *    relative `/api` prefix when config is unavailable (unit tests, non-Nuxt contexts).
 *  - Tenant-context propagation: the JWT lives in an HttpOnly secure cookie (see
 *    security.md — "Token stored in HttpOnly secure cookie (web portal)"). The backend
 *    `tenantGuard` derives RLS context (`company_id`, `user_id`, `role`) from that cookie.
 *    On the CLIENT the browser sends the cookie automatically via `credentials: 'include'`.
 *    On the SERVER (SSR) there is no browser to attach cookies, so we forward the incoming
 *    request's `Cookie` header outbound — otherwise the tenant context would be lost and
 *    every SSR data fetch would run without a company scope.
 *  - Online reads/writes via `$fetch`, mapping the backend error contract
 *    (`{ error: { code, message, details } }`) into a typed {@link ApiError}, never
 *    leaking raw internals (SQL, stack traces) to the caller.
 *  - Typed request surface: `get`/`post`/`put`/`patch`/`delete` — all direct online calls.
 *
 * Binary/photo uploads MUST NOT flow through this client — they use S3 pre-signed URLs.
 */

/** Structured error mirroring the backend API error contract. */
export interface ApiErrorPayload {
  code: string
  message: string
  details?: Record<string, unknown>
}

/**
 * Typed error thrown for request failures. Wraps the backend `{ error }` contract so
 * callers can branch on `code` without inspecting raw responses or stack traces.
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

/** Options common to every request. */
export interface RequestOptions {
  /** Query string parameters (GET). */
  query?: Record<string, unknown>
  /** Request body (mutations); must be JSON-serializable — never binary. */
  body?: Record<string, unknown>
  /** Extra headers merged over the defaults (Authorization/Cookie added automatically). */
  headers?: Record<string, string>
}

/**
 * Provider of an optional bearer token. The web-portal relies on the HttpOnly cookie for
 * auth, so this is usually absent; it exists for parity with the field-pwa client and for
 * contexts (tests, service-to-service) that prefer an explicit `Authorization` header.
 */
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
  /** Send cookies with cross-context requests so the auth cookie reaches the backend. */
  credentials: 'include'
}

/** Options for {@link useApiClient}; all optional so runtime and tests can diverge. */
export interface ApiClientOptions {
  /** Override the base URL (defaults to `runtimeConfig.public.apiBase`, else `/api`). */
  baseUrl?: string
  /** Supply an explicit bearer token (defaults to none — auth flows via HttpOnly cookie). */
  getToken?: TokenProvider
  /** Override the network transport (tests inject a mock; runtime falls back to `$fetch`). */
  fetcher?: ApiFetch
  /**
   * Provide the inbound SSR request's `Cookie` header so it can be forwarded outbound.
   * Runtime defaults to reading it from the Nuxt SSR context; tests inject a value.
   */
  ssrCookie?: string | null
}

/** Public surface returned by {@link useApiClient}. All methods are direct online calls. */
export interface ApiClientApi {
  get: <T>(path: string, options?: RequestOptions) => Promise<T>
  post: <T>(path: string, options?: RequestOptions) => Promise<T>
  put: <T>(path: string, options?: RequestOptions) => Promise<T>
  patch: <T>(path: string, options?: RequestOptions) => Promise<T>
  delete: <T>(path: string, options?: RequestOptions) => Promise<T>
}

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

/**
 * Read the inbound request's `Cookie` header during SSR so it can be forwarded to the
 * backend. On the client this returns null (the browser attaches cookies itself). Never
 * throws outside a Nuxt context — unit tests inject `ssrCookie` explicitly instead.
 */
function tryResolveSsrCookie(): string | null {
  const hook = (globalThis as {
    useRequestHeaders?: (keys: string[]) => Record<string, string | undefined>
  }).useRequestHeaders
  try {
    return typeof hook === 'function' ? (hook(['cookie']).cookie ?? null) : null
  } catch {
    return null
  }
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
  const getToken = options.getToken
  const fetcher = options.fetcher ?? defaultFetcher
  // Resolve the SSR cookie once at construction: capturing the request-scoped header here
  // keeps every subsequent call tenant-scoped without re-reading the Nuxt context per request.
  const ssrCookie = options.ssrCookie !== undefined ? options.ssrCookie : tryResolveSsrCookie()

  /**
   * Build request headers. Attaches a bearer token when one is explicitly provided, and
   * forwards the SSR `Cookie` header so the HttpOnly auth cookie (tenant context) reaches
   * the backend during server-side rendering.
   */
  async function buildHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extra }
    if (ssrCookie) headers.Cookie = ssrCookie
    const token = getToken ? await getToken() : null
    if (token) headers.Authorization = `Bearer ${token}`
    return headers
  }

  /** Perform an online request, mapping transport/HTTP failures into an {@link ApiError}. */
  async function request<T>(method: string, path: string, options: RequestOptions): Promise<T> {
    const headers = await buildHeaders(options.headers)
    try {
      const result = await fetcher(joinUrl(baseUrl, path), {
        method,
        query: options.query,
        body: options.body,
        headers,
        credentials: 'include'
      })
      return result as T
    } catch (err) {
      throw toApiError(err)
    }
  }

  return {
    get: <T>(path: string, options: RequestOptions = {}) => request<T>('GET', path, options),
    post: <T>(path: string, options: RequestOptions = {}) => request<T>('POST', path, options),
    put: <T>(path: string, options: RequestOptions = {}) => request<T>('PUT', path, options),
    patch: <T>(path: string, options: RequestOptions = {}) => request<T>('PATCH', path, options),
    delete: <T>(path: string, options: RequestOptions = {}) => request<T>('DELETE', path, options)
  }
}
