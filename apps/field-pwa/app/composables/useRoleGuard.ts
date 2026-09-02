/**
 * `useRoleGuard` — role-adaptive UI logic for the Field PWA (SALESMAN vs MR).
 *
 * Both field roles share the same PWA shell but see different in-visit workflows and
 * navigation. This composable is the single source of truth for those role decisions so
 * pages/components never scatter `role === 'SALESMAN'` checks around. It owns:
 *  - The current role, read from an injectable source (the Pinia `useAuthStore` once it
 *    lands, or any caller-supplied getter), so this composable never hard-depends on a
 *    store that may not exist yet. It degrades to `null` off-store / off-Nuxt (unit tests).
 *  - Reactive role predicates: {@link RoleGuardApi.isSalesman}, {@link RoleGuardApi.isMr}.
 *  - The order-taking gate: {@link RoleGuardApi.canTakeOrder} and the bottom-nav
 *    {@link RoleGuardApi.showOrderTab} are `true` only for SALESMAN — MR gets a read-only
 *    price/stock lookup instead of the cart (order-taking is SALESMAN-exclusive).
 *  - The ordered list of in-visit step keys for the current role
 *    ({@link RoleGuardApi.inVisitSteps}):
 *      SALESMAN: Detailing → Competitor → Stock Audit → Taking Order
 *      MR:       Detailing → Price/Stock Lookup (read-only) → Competitor  (no Taking Order)
 *
 * The composable performs no network calls and no Dexie writes; it only *derives* UI state
 * from the current role. Server-side enforcement of the same boundary (403 on order routes)
 * lives in the Elysia backend and is intentionally NOT duplicated here.
 */
import { computed, readonly, ref, type Ref } from 'vue'
import { UserRole } from '@maction/types'

/**
 * Stable identifiers for the in-visit workflow steps. Using an enum keeps step ordering and
 * conditional rendering free of magic strings scattered across components.
 */
export enum InVisitStep {
  /** Detailing / agenda logging — shared by SALESMAN & MR. */
  DETAILING = 'DETAILING',
  /** Competitor intelligence audit — shared by SALESMAN & MR. */
  COMPETITOR = 'COMPETITOR',
  /** Shelf stock-on-hand audit — SALESMAN step. */
  STOCK_AUDIT = 'STOCK_AUDIT',
  /** Cart / order taking — SALESMAN exclusive. */
  TAKING_ORDER = 'TAKING_ORDER',
  /** Read-only price & branch-stock lookup — MR exclusive. */
  PRICE_STOCK_LOOKUP = 'PRICE_STOCK_LOOKUP',
}

/** Ordered in-visit steps for a SALESMAN: detailing → competitor → stock → taking order. */
export const SALESMAN_IN_VISIT_STEPS: readonly InVisitStep[] = [
  InVisitStep.DETAILING,
  InVisitStep.COMPETITOR,
  InVisitStep.STOCK_AUDIT,
  InVisitStep.TAKING_ORDER,
]

/** Ordered in-visit steps for an MR: detailing → price/stock lookup → competitor (no order). */
export const MR_IN_VISIT_STEPS: readonly InVisitStep[] = [
  InVisitStep.DETAILING,
  InVisitStep.PRICE_STOCK_LOOKUP,
  InVisitStep.COMPETITOR,
]

/** Provider of the current user's role; `null`/`undefined` when unknown (logged out, tests). */
export type RoleProvider = () => UserRole | null | undefined

/** Options for {@link useRoleGuard}; all optional so runtime and tests can diverge. */
export interface RoleGuardOptions {
  /**
   * Supply the current role (defaults to reading the Pinia `useAuthStore` when it exists,
   * degrading to `null` off-store / off-Nuxt). Inject a getter in unit tests.
   */
  getRole?: RoleProvider
}

/** Public surface returned by {@link useRoleGuard}. */
export interface RoleGuardApi {
  /** The current user's role, or `null` when unknown. */
  role: Readonly<Ref<UserRole | null>>
  /** Whether the current user is a SALESMAN. */
  isSalesman: Readonly<Ref<boolean>>
  /** Whether the current user is an MR. */
  isMr: Readonly<Ref<boolean>>
  /** Whether the current user may take orders (SALESMAN only). */
  canTakeOrder: Readonly<Ref<boolean>>
  /** Whether the "Order" bottom-nav tab and order/cart UI should be shown (SALESMAN only). */
  showOrderTab: Readonly<Ref<boolean>>
  /** The ordered in-visit step keys for the current role (empty when role is unknown). */
  inVisitSteps: Readonly<Ref<readonly InVisitStep[]>>
  /** Re-read the role source (e.g. after login/logout) so derived state updates. */
  refresh: () => void
}

/** Read the role from a globally-registered Pinia `useAuthStore`, if one exists. */
function tryReadStoreRole(): UserRole | null {
  const globalHook = (
    globalThis as { useAuthStore?: () => { role?: UserRole | null } | undefined }
  ).useAuthStore
  try {
    return typeof globalHook === 'function' ? (globalHook()?.role ?? null) : null
  } catch {
    return null
  }
}

/** Resolve a role source, falling back to the Pinia auth store when available. */
function resolveRoleProvider(getRole?: RoleProvider): RoleProvider {
  return getRole ?? tryReadStoreRole
}

export function useRoleGuard(options: RoleGuardOptions = {}): RoleGuardApi {
  const getRole = resolveRoleProvider(options.getRole)

  const role = ref<UserRole | null>(getRole() ?? null)

  const isSalesman = computed(() => role.value === UserRole.SALESMAN)
  const isMr = computed(() => role.value === UserRole.MR)

  // Order-taking is SALESMAN-exclusive; MR is limited to read-only price/stock lookup.
  const canTakeOrder = computed(() => isSalesman.value)
  const showOrderTab = computed(() => canTakeOrder.value)

  const inVisitSteps = computed<readonly InVisitStep[]>(() => {
    if (isSalesman.value) return SALESMAN_IN_VISIT_STEPS
    if (isMr.value) return MR_IN_VISIT_STEPS
    return []
  })

  /** Re-read the injected role source so derived state reflects login/logout changes. */
  function refresh(): void {
    role.value = getRole() ?? null
  }

  return {
    role: readonly(role) as Readonly<Ref<UserRole | null>>,
    isSalesman: readonly(isSalesman) as Readonly<Ref<boolean>>,
    isMr: readonly(isMr) as Readonly<Ref<boolean>>,
    canTakeOrder: readonly(canTakeOrder) as Readonly<Ref<boolean>>,
    showOrderTab: readonly(showOrderTab) as Readonly<Ref<boolean>>,
    inVisitSteps: readonly(inVisitSteps) as Readonly<Ref<readonly InVisitStep[]>>,
    refresh,
  }
}
