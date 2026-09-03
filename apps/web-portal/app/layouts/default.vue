<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'

/**
 * `default` layout — the authenticated admin dashboard shell for the web-portal.
 *
 * Built on Nuxt UI's dashboard primitives (`UDashboardGroup` → `UDashboardSidebar`
 * + `UDashboardPanel`/`UDashboardNavbar`) so we inherit a resizable, collapsible,
 * state-persisted sidebar and a responsive navbar for free. Sidebar collapse/size
 * state is auto-saved by `UDashboardGroup` under the `storage-key` below.
 *
 * Navigation is role-aware: the Super Admin group (tenant provisioning, ERP config)
 * only renders for the `SUPER_ADMIN` role. The nav is a static item list — the
 * layout owns presentation only; feature pages are implemented in later tasks.
 *
 * Forced Light Mode is enforced globally (nuxt.config `colorMode`), so this layout
 * intentionally contains no dark-mode classes or `dark:` variants.
 */

// The auth store is registered by a later Phase 13 task; read the role defensively so
// the layout renders correctly before the store lands (SSR / fresh hydration).
const userRole = computed<string | null>(() => {
  const globalStore = (
    globalThis as { useAuthStore?: () => { roleLabel?: string | null } }
  ).useAuthStore
  try {
    if (typeof globalStore !== 'function') return null
    return globalStore()?.roleLabel ?? null
  } catch {
    return null
  }
})

const isSuperAdmin = computed(() => userRole.value === 'SUPER_ADMIN')

// Primary admin navigation — mirrors the admin routes in the structure spec.
const mainNavItems = computed<NavigationMenuItem[]>(() => [
  { label: 'Dashboard', icon: 'i-lucide-layout-dashboard', to: '/admin/dashboard' },
  { label: 'Live Tracking', icon: 'i-lucide-map-pin', to: '/admin/tracking' },
  { label: 'Customers', icon: 'i-lucide-store', to: '/admin/customers' },
  { label: 'Doctors', icon: 'i-lucide-stethoscope', to: '/admin/doctors' },
  { label: 'Lini & Varian', icon: 'i-lucide-layers', to: '/admin/lini' },
  { label: 'Call Plans', icon: 'i-lucide-calendar-check', to: '/admin/call-plans' },
  { label: 'Orders', icon: 'i-lucide-shopping-cart', to: '/admin/orders' },
  { label: 'Reports', icon: 'i-lucide-bar-chart-3', to: '/admin/reports' },
  { label: 'Absensi & Fraud', icon: 'i-lucide-shield-check', to: '/admin/reports/attendance-fraud' },
  { label: 'Audit & Fraud', icon: 'i-lucide-shield-alert', to: '/admin/audit' }
])

// Super Admin cross-tenant governance — only surfaced to SUPER_ADMIN.
const superAdminNavItems = computed<NavigationMenuItem[]>(() =>
  isSuperAdmin.value
    ? [
        { label: 'Tenants', icon: 'i-lucide-building-2', to: '/admin/super/tenants' },
        { label: 'ERP Config', icon: 'i-lucide-plug', to: '/admin/super/erp-config' }
      ]
    : []
)

// Footer utility links (settings + logout live at the bottom of the sidebar).
const footerNavItems = computed<NavigationMenuItem[]>(() => [
  { label: 'Settings', icon: 'i-lucide-settings', to: '/admin/settings' },
  { label: 'Logout', icon: 'i-lucide-log-out', to: '/auth/login' }
])
</script>

<template>
  <UDashboardGroup
    storage="cookie"
    storage-key="maction-admin-sidebar"
  >
    <UDashboardSidebar
      collapsible
      resizable
      :min-size="16"
      :default-size="18"
      :max-size="26"
      :ui="{ footer: 'border-t border-default' }"
    >
      <template #header="{ collapsed }">
        <NuxtLink
          to="/admin/dashboard"
          class="flex items-center gap-2"
        >
          <UIcon
            name="i-lucide-activity"
            class="size-6 text-primary shrink-0"
          />
          <span
            v-if="!collapsed"
            class="text-base font-semibold text-highlighted"
          >
            KF Maction
          </span>
        </NuxtLink>
      </template>

      <template #default="{ collapsed }">
        <UNavigationMenu
          :collapsed="collapsed"
          :items="mainNavItems"
          orientation="vertical"
        />

        <UNavigationMenu
          v-if="superAdminNavItems.length"
          :collapsed="collapsed"
          :items="superAdminNavItems"
          orientation="vertical"
          class="mt-2"
        />

        <UNavigationMenu
          :collapsed="collapsed"
          :items="footerNavItems"
          orientation="vertical"
          class="mt-auto"
        />
      </template>
    </UDashboardSidebar>

    <UDashboardPanel>
      <template #header>
        <UDashboardNavbar title="KF Maction Admin">
          <template #leading>
            <UDashboardSidebarCollapse />
          </template>
        </UDashboardNavbar>
      </template>

      <template #body>
        <slot />
      </template>
    </UDashboardPanel>
  </UDashboardGroup>
</template>
