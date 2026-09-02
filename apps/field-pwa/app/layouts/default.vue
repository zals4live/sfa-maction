<script setup lang="ts">
// Default app shell for all authenticated `/app/*` pages (SALESMAN & MR). It frames page
// content with two persistent chromes: a top connectivity status bar (Online / Offline /
// Syncing / Error, with the pending-mutation backlog) driven by `useBackgroundSync`, and a
// fixed mobile-first bottom navigation. The "Order" tab is role-gated via `useRoleGuard`
// (SALESMAN only — MR never sees order-taking). Forced light mode (no dark: variants).
import { computed, onMounted, onUnmounted } from 'vue'
import {
  buildNavItems,
  type NavItem
} from './default.nav'

const route = useRoute()
const roleGuard = useRoleGuard()
const sync = useBackgroundSync()

// Bottom-nav tabs; the Order tab is appended only when the role permits order taking.
const navItems = computed<NavItem[]>(() => buildNavItems(roleGuard.showOrderTab.value))

/** Whether a nav item's route is the active one (prefix match for nested pages). */
function isActive(to: string): boolean {
  return route.path === to || route.path.startsWith(`${to}/`)
}

// Watch connectivity while the shell is mounted; refresh the backlog once on entry.
onMounted(() => {
  sync.startConnectivityWatch()
  void sync.refreshPendingCount()
})

onUnmounted(() => {
  sync.stopConnectivityWatch()
})
</script>

<template>
  <div class="flex min-h-dvh flex-col bg-muted">
    <!-- Top connectivity status bar (FR-PWA-07). -->
    <header class="sticky top-0 z-20 border-b border-default bg-default">
      <div class="flex items-center justify-between gap-3 px-4 py-2">
        <div class="flex items-center gap-2">
          <UIcon
            name="i-lucide-map-pin"
            class="size-5 text-primary"
          />
          <span class="text-sm font-semibold text-primary">KF Maction</span>
        </div>

        <SyncStatusIndicator
          :state="sync.connectivity.value"
          :pending-count="sync.pendingCount.value"
        />
      </div>
    </header>

    <!-- Page content. Bottom padding clears the fixed bottom navigation. -->
    <main class="flex-1 pb-20">
      <slot />
    </main>

    <!-- Fixed mobile-first bottom navigation. -->
    <nav
      class="fixed inset-x-0 bottom-0 z-20 border-t border-default bg-default"
      aria-label="Navigasi utama"
    >
      <ul class="mx-auto flex max-w-md items-stretch justify-around">
        <li
          v-for="item in navItems"
          :key="item.to"
          class="flex-1"
        >
          <ULink
            :to="item.to"
            class="flex flex-col items-center gap-0.5 py-2"
            :class="isActive(item.to) ? 'text-primary' : 'text-muted'"
          >
            <UIcon
              :name="item.icon"
              class="size-5"
            />
            <span class="text-[11px] font-medium">{{ item.label }}</span>
          </ULink>
        </li>
      </ul>
    </nav>
  </div>
</template>
