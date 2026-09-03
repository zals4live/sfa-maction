/**
 * `useNavigationDeepLink` — build & launch turn-by-turn navigation deep links.
 *
 * Lets a field user (SALESMAN & MR) hand off the next visit target's coordinates to the
 * device's native maps app for turn-by-turn driving directions:
 *  - iOS → Apple Maps universal link (`https://maps.apple.com/?daddr=lat,lng`).
 *  - Android / everything else → Google Maps directions universal link
 *    (`https://www.google.com/maps/dir/?api=1&destination=lat,lng`), which also resolves in a
 *    browser when no maps app is installed (safe default for an installed PWA).
 *
 * Platform detection and the link opener are both injectable so the composable is SSR-safe and
 * fully testable — nothing touches `window`/`navigator` at module scope. Invalid or missing
 * coordinates yield `null` (and `openNavigation` becomes a no-op), so callers can guard the UI.
 */
import type { GeoPoint } from '@maction/types'

/** Detected device platform influencing which maps scheme we prefer. */
export type NavigationPlatform = 'ios' | 'other'

/** Opens a resolved URL (real runtime uses `window.open`; tests inject a spy). */
export type LinkOpener = (url: string) => void

/** Options for {@link useNavigationDeepLink}; all optional so runtime and tests can diverge. */
export interface NavigationDeepLinkOptions {
  /** Override platform detection (tests force a platform; runtime sniffs the user agent). */
  platform?: NavigationPlatform
  /** Override the link opener (tests inject a spy; runtime falls back to `window.open`). */
  opener?: LinkOpener
}

/** Public surface returned by {@link useNavigationDeepLink}. */
export interface NavigationDeepLinkApi {
  /** The resolved platform used for link generation. */
  platform: NavigationPlatform
  /** Build a navigation URL for the destination, or `null` for missing/invalid coordinates. */
  buildNavigationUrl: (destination: GeoPoint | null | undefined, label?: string) => string | null
  /** Open native navigation to the destination; a no-op for missing/invalid coordinates. */
  openNavigation: (destination: GeoPoint | null | undefined, label?: string) => void
}

/** A finite latitude/longitude within valid WGS84 bounds. */
function isValidGeoPoint(point: GeoPoint | null | undefined): point is GeoPoint {
  if (!point) return false
  const { lat, lng } = point
  return (
    Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= -90 && lat <= 90
    && lng >= -180 && lng <= 180
  )
}

/** Sniff the runtime user agent for iOS; defaults to `other` where unavailable (SSR/tests). */
function detectPlatform(): NavigationPlatform {
  if (typeof navigator === 'undefined') return 'other'
  return /iPad|iPhone|iPod/i.test(navigator.userAgent) ? 'ios' : 'other'
}

/** Runtime opener: open the link in a new tab/native app, falling back to same-tab nav. */
function defaultOpener(url: string): void {
  if (typeof window === 'undefined') return
  window.open(url, '_blank', 'noopener')
}

export function useNavigationDeepLink(options: NavigationDeepLinkOptions = {}): NavigationDeepLinkApi {
  const platform = options.platform ?? detectPlatform()
  const opener = options.opener ?? defaultOpener

  function buildNavigationUrl(destination: GeoPoint | null | undefined, label?: string): string | null {
    if (!isValidGeoPoint(destination)) return null
    const coords = `${destination.lat},${destination.lng}`
    if (platform === 'ios') {
      const query = label ? `&q=${encodeURIComponent(label)}` : ''
      return `https://maps.apple.com/?daddr=${coords}&dirflg=d${query}`
    }
    return `https://www.google.com/maps/dir/?api=1&destination=${coords}`
  }

  function openNavigation(destination: GeoPoint | null | undefined, label?: string): void {
    const url = buildNavigationUrl(destination, label)
    if (url) opener(url)
  }

  return { platform, buildNavigationUrl, openNavigation }
}
