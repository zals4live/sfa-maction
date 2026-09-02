/**
 * Pure helpers for the in-visit execution hub page (`[id]/in-visit.vue`).
 *
 * Extracted from the SFC (mirroring the `visit-in.ts` / `visit-status.ts` pattern) so the
 * step→presentation mapping and the UTabs-items builder can be unit-tested in a browser-free
 * node environment without mounting a Vue component. The role-adaptive step ORDERING itself is
 * NOT decided here — it comes from `useRoleGuard.inVisitSteps` (the single source of truth for
 * the SALESMAN vs MR boundary). This module only maps those already-ordered steps into the
 * label/icon/slot presentation the tab strip renders.
 */
import { InVisitStep } from '~/composables/useRoleGuard'

/** Presentation for a single in-visit step tab (forced light mode — no dark variants). */
export interface InVisitStepPresentation {
  /** Stable step identifier — also used as the UTabs item `value` and content `slot`. */
  step: InVisitStep
  /** Indonesian tab label consistent with the rest of the app. */
  label: string
  /** Lucide icon name for the tab leading icon. */
  icon: string
}

/** A UTabs item projected from an {@link InVisitStep}. `slot` names the per-tab content slot. */
export interface InVisitTabItem {
  label: string
  icon: string
  /** The step value, used for `v-model` and content-slot routing. */
  value: InVisitStep
  /** Named content slot for the step's panel (`#detailing`, `#competitor`, ...). */
  slot: string
}

/** Map each in-visit step to its Indonesian label + icon. Exhaustive over the enum. */
export function inVisitStepPresentation(step: InVisitStep): InVisitStepPresentation {
  switch (step) {
    case InVisitStep.DETAILING:
      return { step, label: 'Detailing', icon: 'i-lucide-clipboard-list' }
    case InVisitStep.COMPETITOR:
      return { step, label: 'Kompetitor', icon: 'i-lucide-swords' }
    case InVisitStep.STOCK_AUDIT:
      return { step, label: 'Audit Stok', icon: 'i-lucide-package-search' }
    case InVisitStep.TAKING_ORDER:
      return { step, label: 'Ambil Order', icon: 'i-lucide-shopping-cart' }
    case InVisitStep.PRICE_STOCK_LOOKUP:
      return { step, label: 'Info Harga & Stok', icon: 'i-lucide-search' }
  }
}

/** Lowercased step key used as the UTabs content-slot name for a step (e.g. `detailing`). */
export function inVisitSlotName(step: InVisitStep): string {
  return step.toLowerCase()
}

/**
 * Project the role's ordered in-visit steps into UTabs items, preserving order. The step
 * ordering is owned by `useRoleGuard`; this only decorates each step with its label/icon/slot
 * so the SFC template stays declarative and free of per-step conditionals.
 */
export function buildInVisitTabs(steps: readonly InVisitStep[]): InVisitTabItem[] {
  return steps.map((step) => {
    const presentation = inVisitStepPresentation(step)
    return {
      label: presentation.label,
      icon: presentation.icon,
      value: step,
      slot: inVisitSlotName(step)
    }
  })
}
