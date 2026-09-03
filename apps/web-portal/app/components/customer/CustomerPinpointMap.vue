<script setup lang="ts">
/**
 * `CustomerPinpointMap` — presentational Leaflet map showing a single customer's location.
 *
 * Given a customer's stored coordinates, it renders one role-neutral circle marker centered
 * on the point with a name tooltip. It owns NO domain state — coordinates arrive via props
 * and this component only visualizes them. When coordinates are absent it renders a "no
 * location" placeholder instead of an empty map.
 *
 * Leaflet touches `window`, so this SFC is meant to be mounted client-only (the page wraps it
 * in <ClientOnly>). Leaflet CSS is registered globally in nuxt.config. Forced Light Mode is
 * global — no dark-mode classes or `dark:` variants here.
 */
import { computed } from 'vue'
import { LMap, LTileLayer, LCircleMarker, LTooltip } from '@vue-leaflet/vue-leaflet'

const props = defineProps<{
  /** Customer name shown in the marker tooltip. */
  name: string
  /** Stored latitude, or null when the customer has no pinned location. */
  latitude: number | null
  /** Stored longitude, or null when the customer has no pinned location. */
  longitude: number | null
}>()

/** OpenStreetMap raster tiles — the shared basemap for all portal maps. */
const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
const TILE_ATTRIBUTION = '&copy; OpenStreetMap contributors'

/** Zoom level used to frame a single pinned customer. */
const PINPOINT_ZOOM = 16

/** Primary design token (`bg-primary-500`) for the marker — matches the portal palette. */
const MARKER_COLOR = '#1C4173'

/** True when both coordinates are present and finite (renderable on the map). */
const hasLocation = computed<boolean>(
  () =>
    props.latitude !== null
    && props.longitude !== null
    && Number.isFinite(props.latitude)
    && Number.isFinite(props.longitude)
)

/** The marker/center position as a Leaflet [lat, lng] tuple, or null when unpinned. */
const center = computed<[number, number] | null>(() =>
  hasLocation.value ? [props.latitude as number, props.longitude as number] : null
)
</script>

<template>
  <div class="relative h-full min-h-[20rem] w-full overflow-hidden rounded-lg bg-elevated">
    <LMap
      v-if="center"
      :zoom="PINPOINT_ZOOM"
      :center="center"
      :use-global-leaflet="false"
      :options="{ attributionControl: true }"
    >
      <LTileLayer
        :url="TILE_URL"
        :attribution="TILE_ATTRIBUTION"
      />
      <LCircleMarker
        :lat-lng="center"
        :radius="9"
        :color="MARKER_COLOR"
        :fill-color="MARKER_COLOR"
        :fill-opacity="0.9"
        :weight="2"
      >
        <LTooltip>
          <span class="text-xs font-semibold text-highlighted">{{ name }}</span>
        </LTooltip>
      </LCircleMarker>
    </LMap>

    <!-- Placeholder when the customer has no stored coordinates. -->
    <div
      v-else
      class="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted"
    >
      <UIcon
        name="i-lucide-map-pin-off"
        class="size-10"
      />
      <span class="text-sm">Lokasi belum ditandai</span>
    </div>
  </div>
</template>
