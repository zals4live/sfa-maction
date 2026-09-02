<script setup lang="ts">
// Presentational Leaflet geofence radar for the visit-in / check-in flows (SALESMAN & MR).
// Renders a map centered on the geofence target, the radius circle, a target marker, and the
// user's live-position marker, with a proximity-driven pulse and a distance/inside-radius
// readout. It owns NO domain state — all readings arrive via props from `useGeofence`; it
// only visualizes them. Leaflet touches `window`, so this SFC is meant to be mounted client
// only (the parent wraps it in <ClientOnly>). Leaflet CSS is registered globally in
// nuxt.config. Forced light mode (no dark: variants).
import { computed } from 'vue'
import { LMap, LTileLayer, LCircle, LCircleMarker, LMarker } from '@vue-leaflet/vue-leaflet'
import type { GeoPoint } from '@maction/types'
import { resolveRadarVisual, type RadarState } from '~/pages/app/visits/visit-in'

interface Props {
  /** Geofence target center (outlet/soffice), or null until resolved. */
  target?: GeoPoint | null
  /** User's current GPS position, or null until a fix arrives. */
  position?: GeoPoint | null
  /** Configured geofence radius in meters. */
  radiusMeters: number
  /** Geodesic distance to the target in meters, or null when unknown. */
  distanceMeters?: number | null
  /** Whether the current position is inside the geofence radius. */
  isWithinRadius: boolean
  /** Clamped 0..1 proximity ratio from `useGeofence` (1 = at center). */
  proximityRatio: number
}

const props = withDefaults(defineProps<Props>(), {
  target: null,
  position: null,
  distanceMeters: null
})

/** OpenStreetMap raster tiles — the shared basemap for all Field PWA maps. */
const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
const TILE_ATTRIBUTION = '&copy; OpenStreetMap contributors'

/** Leaflet consumes [lat, lng] tuples; the map centers on the target when known. */
const centerLatLng = computed<[number, number]>(() =>
  props.target ? [props.target.lat, props.target.lng] : [0, 0]
)

const positionLatLng = computed<[number, number] | null>(() =>
  props.position ? [props.position.lat, props.position.lng] : null
)

/** Discrete radar state + pulse intensity derived by the pure helper (no logic in template). */
const visual = computed(() =>
  resolveRadarVisual(props.distanceMeters, props.isWithinRadius, props.proximityRatio)
)

/** Semantic color for the radius ring + markers, keyed off the radar state (light mode). */
const STATE_COLOR: Record<RadarState, string> = {
  PENDING: '#94A3B8',
  FAR: '#D97706',
  NEAR: '#D97706',
  INSIDE: '#10B981'
}

const ringColor = computed(() => STATE_COLOR[visual.value.state])

/** Rounded distance label, or a pending hint while the first fix resolves. */
const distanceLabel = computed(() =>
  props.distanceMeters === null ? 'Menghitung jarak...' : `${Math.round(props.distanceMeters)} m`
)

/** Pulse radius (px) for the position marker, scaled by proximity intensity. */
const pulseRadius = computed(() => 8 + Math.round(visual.value.intensity * 10))
</script>

<template>
  <div class="flex flex-col gap-2">
    <div class="relative h-64 w-full overflow-hidden rounded-lg bg-elevated">
      <LMap
        v-if="target"
        :zoom="17"
        :center="centerLatLng"
        :use-global-leaflet="false"
        :options="{ zoomControl: false, attributionControl: true }"
      >
        <LTileLayer
          :url="TILE_URL"
          :attribution="TILE_ATTRIBUTION"
        />

        <!-- Geofence radius ring around the target. -->
        <LCircle
          :lat-lng="centerLatLng"
          :radius="radiusMeters"
          :color="ringColor"
          :fill-color="ringColor"
          :fill-opacity="0.12"
          :weight="2"
        />

        <!-- Target center marker. -->
        <LMarker :lat-lng="centerLatLng" />

        <!-- User's current position — a proximity-scaled pulse dot. -->
        <LCircleMarker
          v-if="positionLatLng"
          :lat-lng="positionLatLng"
          :radius="pulseRadius"
          :color="ringColor"
          :fill-color="ringColor"
          :fill-opacity="0.4"
          :weight="2"
        />
      </LMap>

      <!-- Placeholder until the target location resolves from the offline cache. -->
      <div
        v-else
        class="flex size-full flex-col items-center justify-center gap-2 text-muted"
      >
        <UIcon
          name="i-lucide-map-pin-off"
          class="size-10"
        />
        <span class="text-xs">Lokasi target belum tersedia</span>
      </div>
    </div>

    <!-- Distance + inside/outside readout. -->
    <div class="flex items-center justify-between gap-2">
      <div class="flex items-center gap-2">
        <UIcon
          name="i-lucide-ruler"
          class="size-4 text-muted"
        />
        <span class="text-sm font-medium text-highlighted">{{ distanceLabel }}</span>
      </div>

      <UBadge
        :color="isWithinRadius ? 'success' : 'warning'"
        :icon="isWithinRadius ? 'i-lucide-circle-check' : 'i-lucide-circle-alert'"
        variant="subtle"
        size="sm"
      >
        {{ isWithinRadius ? 'Dalam radius' : 'Di luar radius' }}
      </UBadge>
    </div>
  </div>
</template>
