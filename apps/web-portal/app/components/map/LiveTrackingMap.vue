<script setup lang="ts">
/**
 * `LiveTrackingMap` — presentational Leaflet map of live Salesman & MR positions.
 *
 * Renders each tracked field user as a role-colored circle marker (Salesman → `primary`,
 * MR → `warning`, matching the dashboard legend) with an identifying tooltip, plus a
 * chronological breadcrumb polyline behind each marker so an admin can read where a rep has
 * been. It owns NO domain state — the snapshot arrives via the `users` prop from
 * {@link useTracking}; this component only visualizes it and auto-frames the view to fit all
 * markers.
 *
 * Leaflet touches `window`, so this SFC is meant to be mounted client-only (the page wraps
 * it in <ClientOnly>). Leaflet CSS is registered globally in nuxt.config. Forced Light Mode
 * is global — no dark-mode classes or `dark:` variants here.
 */
import { computed, ref, watch } from 'vue'
import { LMap, LTileLayer, LCircleMarker, LPolyline, LTooltip } from '@vue-leaflet/vue-leaflet'
import { UserRole } from '@maction/types'
import type { TrackedUser } from '~/composables/useTracking'

const props = withDefaults(
  defineProps<{
    /** Latest position snapshot for every tracked field user. */
    users: TrackedUser[]
    /** Show breadcrumb trails behind each marker. */
    showTrails?: boolean
  }>(),
  {
    showTrails: true
  }
)

/** OpenStreetMap raster tiles — the shared basemap for all maps. */
const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
const TILE_ATTRIBUTION = '&copy; OpenStreetMap contributors'

/** Fallback center (Jakarta) + zoom used until markers resolve and the view fits them. */
const FALLBACK_CENTER: [number, number] = [-6.2088, 106.8456]
const FALLBACK_ZOOM = 11

/**
 * Semantic role colors resolved from the KF Maction design tokens (see main.css). Leaflet
 * vector layers need concrete color values, so the token hexes are referenced here — they
 * mirror `bg-primary-500` (Salesman) and `bg-warning-500` (MR) used elsewhere in the portal.
 */
const ROLE_COLOR: Record<UserRole.SALESMAN | UserRole.MR, string> = {
  [UserRole.SALESMAN]: '#1C4173',
  [UserRole.MR]: '#D97706'
}

/** Resolve a marker/trail color for a role, defaulting to the Salesman token. */
function colorFor(role: TrackedUser['role_label']): string {
  return ROLE_COLOR[role] ?? ROLE_COLOR[UserRole.SALESMAN]
}

/** Leaflet consumes [lat, lng] tuples. */
function toLatLng(point: { lat: number, lng: number }): [number, number] {
  return [point.lat, point.lng]
}

/** Breadcrumb trail (oldest → newest) as a lat/lng tuple list for the polyline. */
function trailFor(user: TrackedUser): [number, number][] {
  return user.breadcrumbs.map(toLatLng)
}

/** Format an ISO timestamp for the marker tooltip, or a hint when unparseable. */
function formatTimestamp(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString('id-ID')
}

/** The live Leaflet map instance, captured once ready so we can fit bounds to markers. */
const mapRef = ref<{ leafletObject?: {
  fitBounds: (bounds: [number, number][], opts?: Record<string, unknown>) => void
} } | null>(null)

/** All current marker positions — drives auto-fit and the "no data" placeholder. */
const markerLatLngs = computed<[number, number][]>(() => props.users.map(toLatLng))

/**
 * Fit the map to enclose every marker whenever the snapshot changes. A single marker keeps
 * the current zoom (fitBounds on one point would zoom in to street level); an empty snapshot
 * leaves the fallback view in place.
 */
watch(markerLatLngs, (latLngs) => {
  const map = mapRef.value?.leafletObject
  if (!map || latLngs.length < 2) return
  map.fitBounds(latLngs, { padding: [48, 48], maxZoom: 15 })
})
</script>

<template>
  <div class="relative h-full min-h-[28rem] w-full overflow-hidden rounded-lg bg-elevated">
    <LMap
      ref="mapRef"
      :zoom="FALLBACK_ZOOM"
      :center="FALLBACK_CENTER"
      :use-global-leaflet="false"
      :options="{ attributionControl: true }"
    >
      <LTileLayer
        :url="TILE_URL"
        :attribution="TILE_ATTRIBUTION"
      />

      <template
        v-for="user in users"
        :key="user.user_id"
      >
        <!-- Chronological breadcrumb trail behind the marker. -->
        <LPolyline
          v-if="showTrails && user.breadcrumbs.length > 1"
          :lat-lngs="trailFor(user)"
          :color="colorFor(user.role_label)"
          :weight="3"
          :opacity="0.5"
        />

        <!-- Role-colored live position marker with an identifying tooltip. -->
        <LCircleMarker
          :lat-lng="toLatLng(user)"
          :radius="8"
          :color="colorFor(user.role_label)"
          :fill-color="colorFor(user.role_label)"
          :fill-opacity="0.9"
          :weight="2"
        >
          <LTooltip>
            <div class="flex flex-col gap-0.5 text-xs">
              <span class="font-semibold text-highlighted">{{ user.user_name }}</span>
              <span class="text-muted">{{ user.role_label }}</span>
              <span class="text-dimmed">{{ formatTimestamp(user.timestamp) }}</span>
            </div>
          </LTooltip>
        </LCircleMarker>
      </template>
    </LMap>

    <!-- Placeholder overlay when there are no active field users to plot. -->
    <div
      v-if="users.length === 0"
      class="pointer-events-none absolute inset-0 z-[500] flex flex-col items-center justify-center gap-2 bg-elevated/60 text-muted"
    >
      <UIcon
        name="i-lucide-map-pin-off"
        class="size-10"
      />
      <span class="text-sm">Belum ada posisi aktif</span>
    </div>
  </div>
</template>
