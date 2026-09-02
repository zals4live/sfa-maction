/**
 * Pure helpers for the by-phone order entry page (`orders/index.vue`).
 *
 * Extracted from the SFC (mirroring the `visit-status.ts` / `default.nav.ts` pattern) so the
 * customer-option projection and the multi-lini catalog merge can be unit-tested in a
 * framework-agnostic (node) environment without mounting a component. The page consumes
 * these directly, keeping it thin.
 *
 * By-phone context: unlike the in-visit `OrderCart`, there is NO active visit — the SALESMAN
 * picks a customer from the offline cache and the order's `visit_id` is null. These helpers
 * own only the read-side shaping (picker options + catalog de-duplication) — cart mutation,
 * totals, and submission all live in `useCartStore`.
 */
import type { BusinessLine, MasterCustomer, MasterMaterial } from '@maction/types'

/** A customer projected for the `USelectMenu` (`id` value, `name` label). */
export interface CustomerOption {
  id: string
  name: string
}

/**
 * Project cached customers into lightweight `{ id, name }` picker options, keeping only
 * active, non-deleted rows. The label pairs the customer code with its name so a SALESMAN
 * can disambiguate outlets that share a name across territories.
 */
export function toCustomerOptions(customers: readonly MasterCustomer[]): CustomerOption[] {
  return customers
    .filter(customer => customer.is_active && !customer.is_deleted)
    .map(customer => ({ id: customer.id, name: `${customer.code} — ${customer.name}` }))
}

/** De-duplicate a merged material catalog by `id`, preserving first-seen order. */
export function dedupeMaterials(materials: readonly MasterMaterial[]): MasterMaterial[] {
  const seen = new Set<string>()
  const unique: MasterMaterial[] = []
  for (const material of materials) {
    if (seen.has(material.id)) continue
    seen.add(material.id)
    unique.push(material)
  }
  return unique
}

/** The distinct business lines a user's lini-scoped catalog spans (drives the cache reads). */
export function businessLinesFor(assignedLines: readonly BusinessLine[]): BusinessLine[] {
  return Array.from(new Set(assignedLines))
}
