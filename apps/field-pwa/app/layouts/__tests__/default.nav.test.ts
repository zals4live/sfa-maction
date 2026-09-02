import { describe, expect, it } from 'vitest'
import type { ConnectivityState } from '@maction/types'
import {
  BASE_NAV_ITEMS,
  ORDER_NAV_ITEM,
  buildNavItems,
  connectivityPresentation
} from '../default.nav'

describe('default layout — bottom navigation', () => {
  it('should include the Order tab for SALESMAN (showOrderTab = true)', () => {
    const items = buildNavItems(true)
    const paths = items.map(item => item.to)
    expect(paths).toContain(ORDER_NAV_ITEM.to)
    // Every base tab is still present.
    for (const base of BASE_NAV_ITEMS) {
      expect(paths).toContain(base.to)
    }
    // Order sits immediately before Profile (the last base tab).
    expect(paths).toEqual(['/app/visits', '/app/checkin', '/app/orders', '/app/profile'])
  })

  it('should hide the Order tab for MR / unknown roles (showOrderTab = false)', () => {
    const items = buildNavItems(false)
    const paths = items.map(item => item.to)
    expect(paths).not.toContain(ORDER_NAV_ITEM.to)
    expect(paths).toEqual(['/app/visits', '/app/checkin', '/app/profile'])
  })

  it('should return a fresh array rather than mutating the base tabs', () => {
    buildNavItems(true)
    // BASE_NAV_ITEMS must be untouched by the splice in buildNavItems.
    expect(BASE_NAV_ITEMS.map(item => item.to)).toEqual([
      '/app/visits',
      '/app/checkin',
      '/app/profile'
    ])
  })
})

describe('default layout — connectivity status bar (FR-PWA-07)', () => {
  it('should present ONLINE in the success color', () => {
    const status = connectivityPresentation('ONLINE', 0)
    expect(status.label).toBe('Online')
    expect(status.color).toBe('success')
    expect(status.pendingCount).toBe(0)
  })

  it('should present SYNCING in the warning color', () => {
    const status = connectivityPresentation('SYNCING', 0)
    expect(status.label).toBe('Menyinkron')
    expect(status.color).toBe('warning')
  })

  it('should present OFFLINE in the warning color and surface the pending backlog', () => {
    const status = connectivityPresentation('OFFLINE', 3)
    expect(status.label).toBe('Offline')
    expect(status.color).toBe('warning')
    expect(status.pendingCount).toBe(3)
  })

  it('should present ERROR in the error color', () => {
    const status = connectivityPresentation('ERROR', 2)
    expect(status.label).toBe('Gagal sinkron')
    expect(status.color).toBe('error')
    expect(status.pendingCount).toBe(2)
  })

  it('should clamp a negative / non-finite pending count to zero', () => {
    expect(connectivityPresentation('ONLINE', -1).pendingCount).toBe(0)
    expect(connectivityPresentation('ONLINE', Number.NaN).pendingCount).toBe(0)
  })

  it('should fall back to the OFFLINE presentation for an unexpected state', () => {
    const status = connectivityPresentation('UNKNOWN' as ConnectivityState, 0)
    expect(status.label).toBe('Offline')
    expect(status.color).toBe('warning')
  })
})
