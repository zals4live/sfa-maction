/**
 * Pure presentation + status-derivation helpers for the visit list page (`index.vue`).
 *
 * Extracted from the SFC (mirroring the `default.nav.ts` pattern) so the visit-status state
 * machine and its badge presentation can be unit-tested in a framework-agnostic (node)
 * environment without mounting a component. The page and `useVisits` consume these directly.
 *
 * The Field PWA has no local `visits` table, so a plan's lifecycle status is DERIVED offline
 * from two sources that ARE cached:
 *   - `VisitPlan.is_completed` — set true once the executed visit has been synced/closed.
 *   - The Dexie outbox — a pending `VISIT_IN` / `VISIT_OUT` mutation for the plan's customer
 *     reflects an in-progress (or just-completed but unsynced) visit that the server hasn't
 *     acknowledged yet.
 */
import type { LocalOutboxMutation, VisitPlan } from '@maction/types'

/**
 * Derived lifecycle status for a planned visit, shown as a badge on the list. Not a backend
 * enum — the `visits` table is server-only; this is the PWA's offline-derivable projection.
 */
export enum VisitListStatus {
  /** Scheduled for today, not yet started. */
  PLANNED = 'PLANNED',
  /** A visit-in has been recorded (still open — no visit-out yet). */
  IN_PROGRESS = 'IN_PROGRESS',
  /** The visit has been completed (visit-out recorded or the plan is flagged complete). */
  COMPLETED = 'COMPLETED'
}

/** Nuxt UI semantic color token used for a status badge. */
export type VisitStatusColor = 'primary' | 'success' | 'warning' | 'neutral'

/** Resolved badge presentation consumed by the list row. */
export interface VisitStatusPresentation {
  label: string
  icon: string
  color: VisitStatusColor
}

/** Outbox mutation types that signal an in-progress or just-completed visit for a customer. */
const VISIT_IN_MUTATION = 'VISIT_IN'
const VISIT_OUT_MUTATION = 'VISIT_OUT'

/** Read the `customer_id` a visit mutation targets from its queued payload, if present. */
function mutationCustomerId(mutation: LocalOutboxMutation): string | null {
  const customerId = mutation.payload?.customer_id
  return typeof customerId === 'string' ? customerId : null
}

/**
 * Derive a plan's lifecycle status from its `is_completed` flag and the pending outbox.
 * A pending `VISIT_OUT` (or a completed plan) resolves to COMPLETED; a pending `VISIT_IN`
 * alone resolves to IN_PROGRESS; otherwise the plan is still PLANNED.
 */
export function deriveVisitStatus(
  plan: VisitPlan,
  pendingMutations: readonly LocalOutboxMutation[]
): VisitListStatus {
  if (plan.is_completed) return VisitListStatus.COMPLETED
  const forCustomer = pendingMutations.filter(m => mutationCustomerId(m) === plan.customer_id)
  if (forCustomer.some(m => m.mutation_type === VISIT_OUT_MUTATION)) return VisitListStatus.COMPLETED
  if (forCustomer.some(m => m.mutation_type === VISIT_IN_MUTATION)) return VisitListStatus.IN_PROGRESS
  return VisitListStatus.PLANNED
}

/** Map a derived status to its badge label, icon, and semantic color (forced light mode). */
export function visitStatusPresentation(status: VisitListStatus): VisitStatusPresentation {
  switch (status) {
    case VisitListStatus.IN_PROGRESS:
      return { label: 'Berlangsung', icon: 'i-lucide-loader', color: 'warning' }
    case VisitListStatus.COMPLETED:
      return { label: 'Selesai', icon: 'i-lucide-circle-check', color: 'success' }
    case VisitListStatus.PLANNED:
    default:
      return { label: 'Direncanakan', icon: 'i-lucide-calendar-clock', color: 'primary' }
  }
}

/** Format an ISO date (`YYYY-MM-DD`) as the local `YYYY-MM-DD` string for today's lookup. */
export function toPlanDate(date: Date): string {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}
