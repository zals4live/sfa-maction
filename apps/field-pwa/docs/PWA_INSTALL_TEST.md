# PWA Installation Manual Test Checklist — KF Maction Field PWA

Manual QA procedure for **Phase 15** task: _Test PWA installation on Android and iOS (Add to Home Screen)_.

Physical device installation cannot be automated in CI. This document is the authoritative manual test procedure. The installability **configuration** has been verified in code (see "Config Verification" below); the steps here must be executed on real devices before sign-off.

---

## Prerequisites

- App served over **HTTPS** (or `localhost`) — required for service worker + install prompt.
- Production build served (`pnpm --filter field-pwa build && pnpm --filter field-pwa preview`), since `pwa.devOptions.enabled = false`.
- Required icon assets present in `apps/field-pwa/public/`:
  - `pwa-192x192.png` (present)
  - `pwa-512x512.png` (present)
  - `pwa-maskable-512x512.png` — **designer-provided**, must include Android safe-zone padding (~10% margin)
  - `apple-touch-icon.png` — **designer-provided**, 180×180 PNG, no transparency

> Forced Light Mode: `theme_color` and `background_color` must render the light theme. `theme_color = #1C4173` (primary), `background_color = #FFFFFF`. No dark-mode variants.

---

## Android (Chrome)

| # | Step | Expected Result |
|---|------|-----------------|
| 1 | Open the app URL in Chrome (Android) | Page loads over HTTPS; no console SW errors |
| 2 | Wait for install eligibility (or open ⋮ menu) | "Install app" / "Add to Home screen" entry appears |
| 3 | Trigger the install prompt | Install dialog shows app **name** "KF Maction" and the app icon |
| 4 | Confirm "Add to Home Screen" | Icon added to home screen / app drawer using the **maskable** adaptive icon (no white box, correct shape mask) |
| 5 | Launch from home screen icon | App opens in **standalone** mode — no browser address bar or tabs |
| 6 | Observe launch splash | Splash uses `background_color` #FFFFFF and `theme_color` #1C4173; light theme only |
| 7 | Check status bar / theme color | Top system bar reflects `theme_color` #1C4173 |
| 8 | Enable Airplane mode, relaunch app | App shell loads **offline** (Workbox precache); prerendered `/` served |
| 9 | Navigate cached routes offline | Cached app-shell routes render without network |

---

## iOS (Safari)

| # | Step | Expected Result |
|---|------|-----------------|
| 1 | Open the app URL in **Safari** (iOS) | Page loads over HTTPS (install only works in Safari, not third-party browsers) |
| 2 | Tap **Share** → **Add to Home Screen** | Add-to-Home-Screen sheet shows title "Maction" (`apple-mobile-web-app-title`) and the `apple-touch-icon` |
| 3 | Confirm add | Home screen icon uses `apple-touch-icon.png` (opaque, correct rounding applied by iOS) |
| 4 | Launch from home screen icon | App opens in **standalone** display — no Safari chrome (address/tab bar hidden) |
| 5 | Observe status bar | Status bar style = `default` (dark text on light background), consistent with Forced Light Mode |
| 6 | Check safe areas | Layout respects notch/home-indicator (`viewport-fit=cover`) |
| 7 | Enable Airplane mode, relaunch app | App shell loads **offline** from cache |
| 8 | Navigate cached routes offline | Cached routes render without network |

---

## Config Verification (automated / code-level — already checked)

- [x] Manifest fields present: `name`, `short_name`, `description`, `start_url`, `scope`, `display: standalone`, `background_color`, `theme_color`
- [x] Icons declared: 192×192 (`any`), 512×512 (`any`), 512×512 (`maskable`)
- [x] iOS meta present in `app/app.vue`: `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`, `apple-mobile-web-app-title`, `apple-touch-icon` link
- [x] `mobile-web-app-capable` present (Chrome replacement for deprecated apple tag)
- [x] Service worker enabled via `@vite-pwa/nuxt` with `registerType: 'autoUpdate'` and Workbox precache globs
- [x] `theme_color` #1C4173 / `background_color` #FFFFFF — Forced Light Mode consistent

---

## Sign-off

| Platform | Tester | Device / OS | Date | Result |
|----------|--------|-------------|------|--------|
| Android (Chrome) | | | | ☐ Pass ☐ Fail |
| iOS (Safari) | | | | ☐ Pass ☐ Fail |

**Blockers / notes:**

- Provide `pwa-maskable-512x512.png` and `apple-touch-icon.png` (see Prerequisites) before device testing — config references them but the binary assets are designer deliverables.
