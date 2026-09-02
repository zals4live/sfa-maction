/**
 * Pure presentation helpers for the default app shell (`default.vue`).
 *
 * Extracted from the SFC so the role-gated navigation and the connectivity-state → UI
 * mapping can be unit-tested in a framework-agnostic (node) environment without mounting
 * a component. The layout template consumes these directly.
 */
import type { ConnectivityState } from '@maction/types'

/** A single bottom-navigation tab. */
export interface NavItem {
  /** Route path the tab links to. */
  to: string
  /** Short label rendered under the icon. */
  label: string
  /** Lucide icon name (`i-lucide-*`). */
  icon: string
}

/** Nuxt UI semantic color token used for status text/icon/badge. */
export type StatusColor = 'success' | 'warning' | 'error'

/** Resolved connectivity presentation consumed by the status bar. */
export interface ConnectivityPresentation {
  label: string
  icon: string
  color: StatusColor
  pendingCount: number
}

/** Tabs shown to every field role, in display order. */
export const BASE_NAV_ITEMS: readonly NavItem[] = [
  { to: '/app/visits', label: 'Kunjungan', icon: 'i-lucide-map' },
  { to: '/app/checkin', label: 'Absen', icon: 'i-lucide-camera' },
  { to: '/app/profile', label: 'Profil', icon: 'i-lucide-user' }
]

/** The SALESMAN-only order tab, inserted before Profile when order taking is permitted. */
export const ORDER_NAV_ITEM: NavItem = {
  to: '/app/orders',
  label: 'Pesanan',
  icon: 'i-lucide-shopping-cart'
}

/**
 * Build the ordered bottom-nav tabs. The Order tab is included only when `showOrderTab`
 * is true (SALESMAN); MR and unknown roles get the base tabs alone. Order is inserted
 * before Profile so the primary action sits adjacent to the field workflow tabs.
 */
export function buildNavItems(showOrderTab: boolean): NavItem[] {
  if (!showOrderTab) return [...BASE_NAV_ITEMS]
  const items = [...BASE_NAV_ITEMS]
  items.splice(items.length - 1, 0, ORDER_NAV_ITEM)
  return items
}

/**
 * Map a connectivity state (and pending backlog) to its status-bar presentation.
 * Colors follow FR-PWA-07: green (ONLINE), amber (OFFLINE / SYNCING), red (ERROR).
 */
export function connectivityPresentation(
  state: ConnectivityState,
  pendingCount: number
): ConnectivityPresentation {
  const safeCount = Number.isFinite(pendingCount) && pendingCount > 0 ? pendingCount : 0
  switch (state) {
    case 'ONLINE':
      return { label: 'Online', icon: 'i-lucide-wifi', color: 'success', pendingCount: safeCount }
    case 'SYNCING':
      return { label: 'Menyinkron', icon: 'i-lucide-refresh-cw', color: 'warning', pendingCount: safeCount }
    case 'ERROR':
      return { label: 'Gagal sinkron', icon: 'i-lucide-triangle-alert', color: 'error', pendingCount: safeCount }
    case 'OFFLINE':
    default:
      return { label: 'Offline', icon: 'i-lucide-wifi-off', color: 'warning', pendingCount: safeCount }
  }
}
