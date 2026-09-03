import { describe, expect, it, vi } from 'vitest'
import type { GeoPoint } from '@maction/types'
import { useNavigationDeepLink } from '../useNavigationDeepLink'

/** A valid target near Jakarta used across tests. */
const TARGET: GeoPoint = { lat: -6.2, lng: 106.816666 }

describe('useNavigationDeepLink', () => {
  it('should build a Google Maps directions link for non-iOS platforms', () => {
    const nav = useNavigationDeepLink({ platform: 'other' })
    expect(nav.buildNavigationUrl(TARGET)).toBe(
      'https://www.google.com/maps/dir/?api=1&destination=-6.2,106.816666'
    )
  })

  it('should build an Apple Maps link on iOS with an optional encoded label', () => {
    const nav = useNavigationDeepLink({ platform: 'ios' })
    expect(nav.buildNavigationUrl(TARGET)).toBe(
      'https://maps.apple.com/?daddr=-6.2,106.816666&dirflg=d'
    )
    expect(nav.buildNavigationUrl(TARGET, 'Apotek A & B')).toBe(
      'https://maps.apple.com/?daddr=-6.2,106.816666&dirflg=d&q=Apotek%20A%20%26%20B'
    )
  })

  it('should default to the Google Maps universal link when no platform is detectable', () => {
    const nav = useNavigationDeepLink()
    expect(nav.platform).toBe('other')
    expect(nav.buildNavigationUrl(TARGET)).toContain('https://www.google.com/maps/dir/?api=1')
  })

  it('should return null for null/undefined coordinates', () => {
    const nav = useNavigationDeepLink({ platform: 'other' })
    expect(nav.buildNavigationUrl(null)).toBeNull()
    expect(nav.buildNavigationUrl(undefined)).toBeNull()
  })

  it('should return null for out-of-range or non-finite coordinates', () => {
    const nav = useNavigationDeepLink({ platform: 'other' })
    expect(nav.buildNavigationUrl({ lat: 91, lng: 0 })).toBeNull()
    expect(nav.buildNavigationUrl({ lat: 0, lng: 181 })).toBeNull()
    expect(nav.buildNavigationUrl({ lat: Number.NaN, lng: 0 })).toBeNull()
    expect(nav.buildNavigationUrl({ lat: 0, lng: Infinity })).toBeNull()
  })

  it('should invoke the injected opener with the built URL', () => {
    const opener = vi.fn()
    const nav = useNavigationDeepLink({ platform: 'other', opener })

    nav.openNavigation(TARGET)

    expect(opener).toHaveBeenCalledTimes(1)
    expect(opener).toHaveBeenCalledWith(
      'https://www.google.com/maps/dir/?api=1&destination=-6.2,106.816666'
    )
  })

  it('should not invoke the opener for invalid coordinates', () => {
    const opener = vi.fn()
    const nav = useNavigationDeepLink({ platform: 'other', opener })

    nav.openNavigation(null)
    nav.openNavigation({ lat: 999, lng: 999 })

    expect(opener).not.toHaveBeenCalled()
  })
})
