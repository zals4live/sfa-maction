<script setup lang="ts">
// Presentational Leaflet map of the field user's daily route (SALESMAN & MR). Renders the
// ordered MVP/SCP waypoints (outlets/doctors) connected by a Turf.js geodesic (great-circle)
// polyline, numbered markers with name tooltips, an optional live-position marker, and a
// total-distance + stop-count readout. The map fits its bounds to enclose the whole route.
// It owns NO domain state — the ordered waypoints and current position arrive via props; it
// only visualizes them. Leaflet touches `window`, so this SFC is meant to be mounted
// client-only (the parent wraps it in <ClientOnly>). Leaflet CSS is registered globally in
// nuxt.config. Forced light mode (no dark: variants).
import { computed, ref, watch } from 'vue'
import { LMap, LTileLayer, LPolyline, LMarker, LCircleMarker, LTooltip } from '@vue-leaflet/vue-leaflet'
import type { GeoPoint } from '@maction/types'
import { formatDistance } from '@maction/utils'
import {
  routeCenter,
  routeBounds,
  routeGeodesicLatLngs,
  totalRouteDistance,
  toLatLng,
  type RouteWaypoint,
  type LatLngTuple,
  type LatLngBounds
} from '~/lib/map/route-polyline'

interface Props {
  /** Ordered daily route stops (outlets/doctors); the first is stop #1. */
  waypoints: RouteWaypoint[]
  /** User's live GPS position, rendered as a distinct marker when provided. */
  currentPosition?: GeoPoint | null
}

const props = withDefaults(defineProps<Props>(), {
  currentPosition: null
})

/** Minimal shape of the Leaflet map we drive imperatively (only `fitBounds`). */
interface LeafletMap {
  fitBounds: (bounds: LatLngBounds, opts?: Record<string, unknown>) => void
}

/** OpenStreetMap raster tiles — the shared basemap for all Field PWA maps. */
const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
const TILE_ATTRIBUTION = '&copy; OpenStreetMap contributors'

/** primary-500 for the route line, success-500 for the live position (light-mode tokens). */
const ROUTE_COLOR = '#1C4173'
const POSITION_COLOR = '#10B981'

/** The live Leaflet map instance, captured once ready so we can fit bounds to the route. */
const mapRef = ref<{ leafletObject?: LeafletMap } | null>(null)

/** Centroid of all waypoints, or null for an empty route (drives the placeholder + center). */
const center = computed<LatLngTuple | null>(() => routeCenter(props.waypoints))

/** Ordered [lat, lng] tuples feeding the numbered stop markers. */
const geodesicLatLngs = computed<LatLngTuple[]>(() => routeGeodesicLatLngs(props.waypoints))

/** Live-position tuple, or null until a fix arrives / when not tracked. */
const positionLatLng = computed<LatLngTuple | null>(() =>
  props.currentPosition ? toLatLng(props.currentPosition) : null
)

/** Human-readable total distance across consecutive legs (id-ID meters/km). */
const distanceLabel = computed(() => formatDistance(totalRouteDistance(props.waypoints)))

/** Stop count for the readout badge. */
const stopCount = computed(() => props.waypoints.length)

/** Fit the map to enclose the whole route; a single stop keeps the centered default zoom. */
function fitToRoute(): void {
  const map = mapRef.value?.leafletObject
  const bounds = routeBounds(props.waypoints)
  if (!map || !bounds || props.waypoints.length < 2) return
  map.fitBounds(bounds, { padding: [48, 48], maxZoom: 16 })
}

/** Map ready → frame the initial route. */
function onMapReady(): void {
  fitToRoute()
}

/** Re-fit whenever the route changes (map may not be ready yet on the first change). */
watch(() => props.waypoints, () => {
  if (mapRef.value?.leafletObject) fitToRoute()
})
</script>

<template>
  <div class="flex flex-col gap-2">
    <div class="relative h-64 w-full overflow-hidden rounded-lg bg-elevated">
      <LMap
        v-if="center"
        ref="mapRef"
        :zoom="13"
        :center="center"
        :use-global-leaflet="false"
        :options="{ zoomControl: false, attributionControl: true }"
        @ready="onMapReady"
      >
        <LTileLayer
          :url="TILE_URL"
          :attribution="TILE_ATTRIBUTION"
        />

        <!-- Geodesic (great-circle) route line connecting the stops in order. -->
        <LPolyline
          v-if="geodesicLatLngs.length > 1"
          :lat-lngs="geodesicLatLngs"
          :color="ROUTE_COLOR"
          :weight="3"
          :opacity="0.8"
        />

        <!-- Numbered stop markers with a name + sequence tooltip. -->
        <LMarker
          v-for="(waypoint, index) in waypoints"
          :key="index"
          :lat-lng="toLatLng(waypoint.point)"
        >
          <LTooltip>{{ index + 1 }}. {{ waypoint.name }}</LTooltip>
        </LMarker>

        <!-- User's current position — a distinct success-colored dot. -->
        <LCircleMarker
          v-if="positionLatLng"
          :lat-lng="positionLatLng"
          :radius="8"
          :color="POSITION_COLOR"
          :fill-color="POSITION_COLOR"
          :fill-opacity="0.4"
          :weight="2"
        />
      </LMap>

      <!-- Placeholder until the daily route resolves from the offline cache. -->
      <div
        v-else
        class="flex size-full flex-col items-center justify-center gap-2 text-muted"
      >
        <UIcon
          name="i-lucide-route-off"
          class="size-10"
        />
        <span class="text-xs">Rute harian belum tersedia</span>
      </div>
    </div>

    <!-- Total distance + stop-count readout. -->
    <div class="flex items-center justify-between gap-2">
      <div class="flex items-center gap-2">
        <UIcon
          name="i-lucide-route"
          class="size-4 text-muted"
        />
        <span class="text-sm font-medium text-highlighted">{{ distanceLabel }}</span>
      </div>

      <UBadge
        color="primary"
        icon="i-lucide-map-pin"
        variant="subtle"
        size="sm"
      >
        {{ stopCount }} kunjungan
      </UBadge>
    </div>
  </div>
</template>
