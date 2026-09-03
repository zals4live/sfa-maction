<script setup lang="ts">
/**
 * `/admin/tracking` — live field-force GPS tracking page for admin roles.
 *
 * Renders a full-bleed Leaflet map showing real-time positions of both Salesman and MR
 * field users, visually distinguished by role color (Salesman → primary, MR → warning).
 * Position data is polled from `GET /tracking/live-positions` via {@link useTracking},
 * refreshing on a 15-second cadence. An optional role filter lets the admin isolate
 * Salesman-only or MR-only views.
 *
 * Access is gated by the `auth` middleware (ADMIN_CABANG / ADMIN_PUSAT / SUPER_ADMIN);
 * the backend independently enforces the same boundary via tenant + role guards. Forced
 * Light Mode is global — no dark-mode classes or `dark:` variants here.
 */
import type { SelectItem } from '@nuxt/ui'
import { UserRole } from '@maction/types'
import { useTracking, type FieldRole, type LivePositionsQuery } from '~/composables/useTracking'
import LiveTrackingMap from '~/components/map/LiveTrackingMap.vue'

definePageMeta({
  layout: 'default',
  middleware: 'auth'
})

useHead({ title: 'Live Tracking — KF Maction Admin' })

const tracking = useTracking()

/** Role filter for narrowing the map to one field role. */
type RoleFilter = '' | 'SALESMAN' | 'MR'
const roleFilter = ref<RoleFilter>('')

const roleItems: SelectItem[] = [
  { label: 'Semua', value: '' },
  { label: 'Salesman', value: 'SALESMAN' },
  { label: 'MR', value: 'MR' }
]

/** Build the API query from the active role filter. */
function buildQuery(): LivePositionsQuery {
  const query: LivePositionsQuery = {}
  if (roleFilter.value) {
    query.role = roleFilter.value as FieldRole
  }
  return query
}

/** Start polling when the page mounts; restart when the role filter changes. */
function restartPolling(): void {
  tracking.startPolling(buildQuery())
}

watch(roleFilter, restartPolling)

onMounted(restartPolling)
onBeforeUnmount(() => tracking.stopPolling())

/** Summary counts per role for the header legend. */
const salesmanCount = computed(() =>
  tracking.positions.value.filter(u => u.role_label === UserRole.SALESMAN).length
)
const mrCount = computed(() =>
  tracking.positions.value.filter(u => u.role_label === UserRole.MR).length
)

/** Human-readable "last updated" caption. */
const lastUpdated = computed<string | null>(() => {
  const ms = tracking.lastUpdatedAt.value
  if (!ms) return null
  return new Date(ms).toLocaleTimeString('id-ID')
})
</script>

<template>
  <div class="flex h-full flex-col gap-4 p-4 sm:p-6">
    <!-- Header + controls -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold text-highlighted">
          Live Tracking
        </h1>
        <p class="mt-0.5 text-sm text-muted">
          Posisi real-time Salesman & MR di lapangan.
        </p>
      </div>

      <div class="flex items-center gap-3">
        <!-- Role legend chips -->
        <div class="hidden items-center gap-3 text-xs text-muted sm:flex">
          <span class="flex items-center gap-1.5">
            <span class="size-2.5 rounded-full bg-primary-500" />
            Salesman ({{ salesmanCount }})
          </span>
          <span class="flex items-center gap-1.5">
            <span class="size-2.5 rounded-full bg-warning-500" />
            MR ({{ mrCount }})
          </span>
        </div>

        <USelect
          v-model="roleFilter"
          :items="roleItems"
          value-key="value"
          icon="i-lucide-filter"
          class="w-36"
        />
      </div>
    </div>

    <!-- Error banner -->
    <UAlert
      v-if="tracking.error.value"
      color="error"
      variant="soft"
      icon="i-lucide-circle-alert"
      title="Gagal memuat data tracking"
      description="Posisi lapangan tidak dapat dimuat saat ini. Polling akan otomatis mencoba ulang."
    />

    <!-- Map — client-only to avoid Leaflet SSR issues. -->
    <div class="relative flex-1">
      <ClientOnly>
        <LiveTrackingMap :users="tracking.positions.value" />
        <template #fallback>
          <div class="flex h-full min-h-[28rem] items-center justify-center rounded-lg bg-elevated text-muted">
            <UIcon
              name="i-lucide-loader"
              class="size-8 animate-spin"
            />
          </div>
        </template>
      </ClientOnly>
    </div>

    <!-- Footer: last updated + polling indicator -->
    <div class="flex items-center gap-3 text-xs text-dimmed">
      <span
        v-if="tracking.isPolling.value"
        class="flex items-center gap-1.5"
      >
        <span class="size-2 rounded-full bg-success-500 animate-pulse" />
        Polling aktif
      </span>
      <span v-if="lastUpdated">
        Diperbarui: {{ lastUpdated }}
      </span>
    </div>
  </div>
</template>
