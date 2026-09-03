<script setup lang="ts">
/**
 * `TerritoryCluster` — presentational Leaflet map visualizing outlet & doctor coverage density.
 *
 * Plots every supplied customer point (Outlets and Doctors) and groups nearby markers into
 * clusters via `leaflet.markercluster`, so an admin can read territory coverage density at a
 * glance: dense areas collapse into count badges, sparse areas show individual pins. Outlets
 * render in the `primary` brand color, Doctors in `warning` — mirroring the portal legend.
 *
 * It owns NO domain state — points arrive via the `points` prop; this component only visualizes
 * them, auto-frames the view to fit all markers, and emits `select` when a marker is clicked.
 *
 * Clustering is imperative (no `@vue-leaflet` wrapper exists for it), so Leaflet and the
 * markercluster plugin are loaded lazily on the client and the map is wrapped in <ClientOnly>
 * to avoid SSR `window` access. Leaflet + MarkerCluster CSS is registered globally in
 * nuxt.config. Forced Light Mode is global — no dark-mode classes or `dark:` variants here.
 */
import { ref, watch } from 'vue'
import { LMap, LTileLayer } from '@vue-leaflet/vue-leaflet'

/** Customer type discriminator — mirrors the PostgreSQL `customer_type_enum` values plotted here. */
type CustomerKind = 'OUTLET' | 'DOCTOR'

/** A single plottable customer point with the fields needed for density visualization. */
export interface TerritoryPoint {
  id: string
  name: string
  customer_type: CustomerKind
  lat: number
  lng: number
}

const props = withDefaults(
  defineProps<{
    /** Outlet & doctor points to cluster on the map. */
    points: TerritoryPoint[]
    /** Initial map center [lat, lng]; defaults to Jakarta. */
    center?: [number, number]
    /** Initial zoom level. */
    zoom?: number
  }>(),
  {
    center: () => [-6.2088, 106.8456],
    zoom: 11
  }
)

const emit = defineEmits<{
  /** A marker was clicked — carries the selected point. */
  select: [point: TerritoryPoint]
}>()

/** OpenStreetMap raster tiles — the shared basemap for all portal maps. */
const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
const TILE_ATTRIBUTION = '&copy; OpenStreetMap contributors'

/**
 * Semantic marker colors resolved from the KF Maction design tokens (see main.css). Leaflet
 * divIcons need concrete color values, so the token hexes are referenced here — they mirror
 * `bg-primary-500` (Outlet) and `bg-warning-500` (Doctor) used across the portal.
 */
const KIND_COLOR: Record<CustomerKind, string> = {
  OUTLET: '#1C4173',
  DOCTOR: '#D97706'
}

/**
 * Minimal structural shapes of the Leaflet APIs we touch. This mirrors the sibling map
 * components (LiveTrackingMap, PinPicker), which deliberately avoid a hard `leaflet` type
 * dependency and type Leaflet structurally instead.
 */
interface LeafletLayer { on: (event: string, handler: () => void) => void }
interface LeafletBounds { isValid: () => boolean }
interface LeafletClusterGroup {
  addLayer: (layer: LeafletLayer) => void
  clearLayers: () => void
  getBounds: () => LeafletBounds
}
interface LeafletMap {
  addLayer: (group: LeafletClusterGroup) => void
  fitBounds: (bounds: LeafletBounds, opts?: Record<string, unknown>) => void
}
interface LeafletDivIconOptions { html: string, className: string, iconSize: [number, number] }
interface LeafletMarkerOptions { icon: unknown, title: string }
/** The subset of the Leaflet module we call after lazy-loading it. */
interface LeafletApi {
  divIcon: (opts: LeafletDivIconOptions) => unknown
  marker: (latLng: [number, number], opts: LeafletMarkerOptions) => LeafletLayer
  markerClusterGroup: () => LeafletClusterGroup
}

/** The live Leaflet map instance, captured once ready so we can attach the cluster group. */
const mapRef = ref<{ leafletObject?: LeafletMap } | null>(null)

/** The active cluster group, retained so re-renders can clear and repopulate its markers. */
let clusterGroup: LeafletClusterGroup | null = null

/** Build the HTML for a customer marker's colored divIcon. */
function markerHtml(kind: CustomerKind): string {
  const color = KIND_COLOR[kind]
  return `<span class="block size-3.5 rounded-full border-2 border-white shadow" style="background:${color}"></span>`
}

/** Create a Leaflet marker for a point, wired to emit `select` on click. */
function buildMarker(L: LeafletApi, point: TerritoryPoint): LeafletLayer {
  const icon = L.divIcon({ html: markerHtml(point.customer_type), className: '', iconSize: [14, 14] })
  const marker = L.marker([point.lat, point.lng], { icon, title: point.name })
  marker.on('click', () => emit('select', point))
  return marker
}

/** Fit the map view to enclose every clustered marker, when any exist. */
function fitToMarkers(map: LeafletMap, group: LeafletClusterGroup): void {
  const bounds = group.getBounds()
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [48, 48], maxZoom: 15 })
}

/** Rebuild the cluster group from the current points and re-frame the view. */
function renderClusters(L: LeafletApi, map: LeafletMap): void {
  if (!clusterGroup) {
    clusterGroup = L.markerClusterGroup()
    map.addLayer(clusterGroup)
  }
  clusterGroup.clearLayers()
  for (const point of props.points) clusterGroup.addLayer(buildMarker(L, point))
  fitToMarkers(map, clusterGroup)
}

/** Lazily load Leaflet + markercluster on the client, then render clusters. */
async function loadAndRender(): Promise<void> {
  const map = mapRef.value?.leafletObject
  if (!map) return
  const leaflet = await import('leaflet')
  // markercluster augments the global L with `markerClusterGroup`.
  await import('leaflet.markercluster')
  const L = (leaflet.default ?? leaflet) as unknown as LeafletApi
  renderClusters(L, map)
}

/** Map ready → attach the cluster group with the initial points. */
function onMapReady(): void {
  void loadAndRender()
}

/** Re-cluster whenever the points change (map may not be ready yet on the first change). */
watch(() => props.points, () => {
  if (mapRef.value?.leafletObject) void loadAndRender()
})
</script>

<template>
  <div class="relative h-full min-h-[28rem] w-full overflow-hidden rounded-lg bg-elevated">
    <ClientOnly>
      <LMap
        ref="mapRef"
        :zoom="zoom"
        :center="center"
        :use-global-leaflet="false"
        :options="{ attributionControl: true }"
        @ready="onMapReady"
      >
        <LTileLayer
          :url="TILE_URL"
          :attribution="TILE_ATTRIBUTION"
        />
      </LMap>

      <template #fallback>
        <div class="absolute inset-0 flex items-center justify-center text-muted">
          <UIcon
            name="i-lucide-loader-circle"
            class="size-6 animate-spin"
          />
        </div>
      </template>
    </ClientOnly>

    <!-- Legend distinguishing Outlet vs Doctor markers. -->
    <div class="absolute right-3 top-3 z-[500] flex flex-col gap-1.5 rounded-lg border border-default bg-default/90 px-3 py-2 text-xs shadow">
      <div class="flex items-center gap-2">
        <span class="size-3 rounded-full bg-primary-500" />
        <span class="text-muted">Outlet</span>
      </div>
      <div class="flex items-center gap-2">
        <span class="size-3 rounded-full bg-warning-500" />
        <span class="text-muted">Dokter</span>
      </div>
    </div>

    <!-- Placeholder overlay when there are no points to plot. -->
    <div
      v-if="points.length === 0"
      class="pointer-events-none absolute inset-0 z-[400] flex flex-col items-center justify-center gap-2 bg-elevated/60 text-muted"
    >
      <UIcon
        name="i-lucide-map-pin-off"
        class="size-10"
      />
      <span class="text-sm">Belum ada data cakupan</span>
    </div>
  </div>
</template>
