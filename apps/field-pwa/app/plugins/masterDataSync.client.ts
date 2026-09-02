/**
 * Client launch plugin — hydrate the session, then sync master data into Dexie.
 *
 * Runs once per app launch (client-only; Dexie/IndexedDB are browser-only). It first
 * restores any persisted session via `useAuthStore.hydrate()`, then kicks off
 * {@link useMasterDataSync} to hydrate the offline database with the field user's scoped
 * master data (customers, doctors + assignments, user-lini assignments, lini-filtered
 * materials, today's visit plans).
 *
 * The sync is intentionally fire-and-forget so launch is never blocked on the network,
 * and it is a no-op unless the user is authenticated and online — so it never runs on the
 * login page. When offline at launch, the app falls back to whatever is already cached.
 */
import { defineNuxtPlugin } from 'nuxt/app'
import { useAuthStore } from '~/stores/useAuthStore'
import { useMasterDataSync } from '~/composables/useMasterDataSync'

export default defineNuxtPlugin(() => {
  const auth = useAuthStore()

  // Restore token + profile from storage so `isAuthenticated` is accurate before syncing.
  auth.hydrate()

  if (!auth.isAuthenticated) return

  // Fire-and-forget: the composable guards on auth + connectivity internally.
  const sync = useMasterDataSync()
  void sync.syncMasterData()
})
