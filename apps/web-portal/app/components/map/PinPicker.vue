<script setup lang="ts">
/**
 * `PinPicker` — interactive coordinate picker modal for GPS recalibration.
 *
 * Lets an admin re-pin a customer/outlet location by dragging a marker or clicking anywhere on
 * a Leaflet basemap; both gestures update the working `latitude`/`longitude`, shown as a live
 * readout. The coordinates are two-way bound via `v-model` (`modelValue`), so the parent always
 * mirrors the current pick. Confirming emits `confirm` with the chosen point (the parent
 * persists it via `useCustomers`); cancelling closes without side effects.
 *
 * The modal's open state is controlled by the parent via `v-model:open`. Leaflet touches
 * `window`, so the map is wrapped in <ClientOnly>; Leaflet CSS is registered globally in
 * nuxt.config. Forced Light Mode is global — no dark-mode classes or `dark:` variants here.
 */
import { computed, ref, watch } from 'vue'
import { LMap, LTileLayer, LMarker } from '@vue-leaflet/vue-leaflet'

/** A geographic point in decimal degrees. */
export interface Coordinates {
  latitude: number
  longitude: number
}

/** Minimal structural shape of Leaflet's `LatLng` (avoids a hard `leaflet` type dep). */
interface LatLng {
  lat: number
  lng: number
}

/** Minimal structural shape of a Leaflet mouse event carrying a `latlng`. */
interface LeafletMouseEvent {
  latlng: LatLng
}

/** Minimal structural shape of the Leaflet map instance we interact with. */
interface LeafletMap {
  on: (event: string, handler: (event: LeafletMouseEvent) => void) => void
}

const props = withDefaults(
  defineProps<{
    /** Whether the modal is open (controlled by the parent via `v-model:open`). */
    open: boolean
    /** Current coordinates (two-way bound via `v-model`); null when unpinned. */
    modelValue: Coordinates | null
    /** Initial zoom level when the map opens. */
    zoom?: number
    /** Whether the marker can be dragged to re-pin. */
    draggable?: boolean
  }>(),
  {
    zoom: 16,
    draggable: true
  }
)

const emit = defineEmits<{
  'update:open': [value: boolean]
  'update:modelValue': [value: Coordinates]
  'confirm': [value: Coordinates]
}>()

/** OpenStreetMap raster tiles — the shared basemap for all portal maps. */
const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
const TILE_ATTRIBUTION = '&copy; OpenStreetMap contributors'

/** Fallback center (Jakarta) used when no coordinates are supplied yet. */
const FALLBACK_CENTER: Coordinates = { latitude: -6.2088, longitude: 106.8456 }

/** Working pick — the marker/center position the admin is editing. */
const pick = ref<Coordinates>(props.modelValue ?? FALLBACK_CENTER)

/** Rehydrate the working pick whenever the modal (re)opens, discarding stale edits. */
watch(
  () => [props.open, props.modelValue] as const,
  ([open]) => {
    if (open) pick.value = props.modelValue ?? FALLBACK_CENTER
  },
  { immediate: true }
)

/** Leaflet consumes [lat, lng] tuples. */
const markerLatLng = computed<[number, number]>(() => [pick.value.latitude, pick.value.longitude])

/** Commit a new pick to local state and mirror it to the parent via `v-model`. */
function setPick(coords: Coordinates): void {
  pick.value = coords
  emit('update:modelValue', coords)
}

/** Marker drag/move → adopt the marker's new position. */
function onMarkerMove(latLng: LatLng): void {
  setPick({ latitude: latLng.lat, longitude: latLng.lng })
}

/** Map click → move the pin to the clicked point. */
function onMapClick(event: LeafletMouseEvent): void {
  setPick({ latitude: event.latlng.lat, longitude: event.latlng.lng })
}

/** Wire the map's native click handler once Leaflet is ready. */
function onMapReady(map: LeafletMap): void {
  map.on('click', onMapClick)
}

/** Confirm the pick — hand the chosen coordinates to the parent and close. */
function onConfirm(): void {
  emit('confirm', pick.value)
  emit('update:open', false)
}

/** Close the modal without persisting. */
function onCancel(): void {
  emit('update:open', false)
}

/** Format a coordinate for the readout (6 dp ≈ 0.1 m precision). */
function formatCoord(value: number): string {
  return value.toFixed(6)
}
</script>

<template>
  <UModal
    :open="open"
    title="Kalibrasi Titik GPS"
    description="Seret penanda atau klik peta untuk menetapkan koordinat lokasi."
    @update:open="emit('update:open', $event)"
  >
    <template #body>
      <div class="flex flex-col gap-4">
        <div class="relative h-80 w-full overflow-hidden rounded-lg bg-elevated sm:h-96">
          <ClientOnly>
            <LMap
              :zoom="zoom"
              :center="markerLatLng"
              :use-global-leaflet="false"
              :options="{ attributionControl: true }"
              @ready="onMapReady"
            >
              <LTileLayer
                :url="TILE_URL"
                :attribution="TILE_ATTRIBUTION"
              />
              <LMarker
                :lat-lng="markerLatLng"
                :draggable="draggable"
                @update:lat-lng="onMarkerMove"
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
        </div>

        <!-- Live coordinate readout -->
        <div class="grid grid-cols-2 gap-3">
          <div class="rounded-lg border border-default bg-elevated/50 px-3 py-2">
            <p class="text-xs text-muted">
              Latitude
            </p>
            <p class="font-mono text-sm text-highlighted">
              {{ formatCoord(pick.latitude) }}
            </p>
          </div>
          <div class="rounded-lg border border-default bg-elevated/50 px-3 py-2">
            <p class="text-xs text-muted">
              Longitude
            </p>
            <p class="font-mono text-sm text-highlighted">
              {{ formatCoord(pick.longitude) }}
            </p>
          </div>
        </div>
      </div>
    </template>

    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          label="Batal"
          @click="onCancel"
        />
        <UButton
          color="primary"
          icon="i-lucide-map-pin-check"
          label="Simpan Titik"
          @click="onConfirm"
        />
      </div>
    </template>
  </UModal>
</template>
