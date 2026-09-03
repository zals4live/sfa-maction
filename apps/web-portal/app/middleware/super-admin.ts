/**
 * `super-admin` route middleware — gate cross-tenant governance pages to `SUPER_ADMIN`.
 *
 * Pages under `/admin/super/*` (tenant provisioning, ERP config) opt in with
 * `definePageMeta({ middleware: ['auth', 'super-admin'] })`. This is the SECOND line of a
 * defense-in-depth strategy layered on top of {@link auth}: `auth` proves the visitor is
 * authenticated; this guard additionally proves they hold the `SUPER_ADMIN` role before a
 * cross-tenant page renders. The backend independently enforces the same boundary via its
 * role-guard middleware (`SUPER_ADMIN_ONLY`), so a missing/forged client token can never
 * yield privileged data — this guard only keeps the UI honest.
 *
 * The role is resolved from the Pinia `useAuthStore` (`roleLabel`), the single source of truth
 * for the decoded session. The lookup is null-safe: the store may not be registered yet and is
 * unavailable during SSR, so every access degrades to "not a super admin" rather than throwing.
 * A non-super-admin (or unresolved role) is sent back to the dashboard rather than the login
 * page — they are authenticated, just not authorized for this area.
 */

/** Role required to view cross-tenant governance pages. */
export const REQUIRED_ROLE = 'SUPER_ADMIN'

/** Route non-super-admins are redirected to (an area every admin role can access). */
export const FALLBACK_ROUTE = '/admin/dashboard'

/** Read `roleLabel` from the Pinia auth store when it is registered; else `null`. */
function readStoreRole(): string | null {
  const globalStore = (
    globalThis as { useAuthStore?: () => { roleLabel?: string | null } }
  ).useAuthStore
  try {
    if (typeof globalStore !== 'function') return null
    return globalStore()?.roleLabel ?? null
  } catch {
    return null
  }
}

export default defineNuxtRouteMiddleware(() => {
  if (readStoreRole() === REQUIRED_ROLE) return
  return navigateTo(FALLBACK_ROUTE)
})
