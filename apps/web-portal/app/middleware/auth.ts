/**
 * `auth` route middleware — gate authenticated admin pages of the web-portal.
 *
 * Pages opt in with `definePageMeta({ middleware: 'auth' })`. The portal serves
 * ADMIN_CABANG / ADMIN_PUSAT / SUPER_ADMIN roles; this is the FIRST line of the
 * defense-in-depth strategy — it redirects unauthenticated visitors to the login page
 * before a protected page renders. The backend independently enforces the same boundary
 * via the tenant-guard + role-guard middleware, so a missing/forged client token can
 * never yield privileged data.
 *
 * Authentication is resolved from two sources, in order of precedence:
 *   1. The Pinia `useAuthStore` (`isAuthenticated`) once it lands — the single source of
 *      truth for the decoded, unexpired session.
 *   2. The opaque JWT persisted under {@link AUTH_TOKEN_STORAGE_KEY} — the same key the
 *      API client attaches, letting a freshly-hydrated client be recognized immediately.
 *
 * The lookups are null-safe: the store may not be registered yet and `localStorage` is
 * unavailable during SSR, so every access degrades to "unauthenticated" rather than
 * throwing. The route it protects always redirects to {@link AUTH_LOGIN_ROUTE}.
 */

/** Local-storage key holding the opaque JWT (shared with the API client). */
export const AUTH_TOKEN_STORAGE_KEY = 'maction_auth_token'

/** Route unauthenticated visitors are redirected to. */
export const AUTH_LOGIN_ROUTE = '/auth/login'

/** Read `isAuthenticated` from the Pinia auth store when it is registered; else `null`. */
function readStoreAuth(): boolean | null {
  const globalStore = (
    globalThis as { useAuthStore?: () => { isAuthenticated?: boolean } }
  ).useAuthStore
  try {
    if (typeof globalStore !== 'function') return null
    const state = globalStore()
    return typeof state?.isAuthenticated === 'boolean' ? state.isAuthenticated : null
  } catch {
    return null
  }
}

/** Whether a persisted JWT exists in client storage; false under SSR / locked-down runtimes. */
function hasPersistedToken(): boolean {
  if (typeof localStorage === 'undefined') return false
  try {
    return Boolean(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY))
  } catch {
    return false
  }
}

export default defineNuxtRouteMiddleware((to) => {
  // Never guard the login page itself, or we would loop redirecting.
  if (to.path === AUTH_LOGIN_ROUTE) return

  const storeAuth = readStoreAuth()
  const isAuthenticated = storeAuth ?? hasPersistedToken()
  if (isAuthenticated) return

  return navigateTo(AUTH_LOGIN_ROUTE)
})
