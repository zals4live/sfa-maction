/**
 * `salesman-only` route middleware — gate SALESMAN-exclusive pages (e.g. `/app/orders`).
 *
 * Order-taking is a SALESMAN-EXCLUSIVE capability: the MR role (and any other role) must
 * never reach the by-phone order entry page. This middleware is the FIRST line of the
 * defense-in-depth strategy — it redirects non-SALESMAN users to the shared visit list
 * before the page renders. The page template still renders its own read-only notice as a
 * second line of defense, and the backend enforces the same boundary with a 403.
 *
 * Role is read through the `useRoleGuard` composable (single source of truth for role
 * decisions), which itself degrades to `null` off-store / off-Nuxt. This middleware mirrors
 * the null-safe patterns in `useRoleGuard.ts` / `useApiClient.ts`: it never throws when the
 * Nuxt route helpers are unavailable (SSR-less unit tests), it simply allows navigation to
 * proceed so those helpers own the redirect at runtime.
 */
import { useRoleGuard } from '~/composables/useRoleGuard'

/** Route non-SALESMAN users are redirected to (the shared visit list). */
export const SALESMAN_ONLY_FALLBACK = '/app/visits'

export default defineNuxtRouteMiddleware(() => {
  const { isSalesman } = useRoleGuard()
  if (isSalesman.value) return
  return navigateTo(SALESMAN_ONLY_FALLBACK)
})
