<script setup lang="ts">
// Read-only price & stock lookup for the in-visit execution hub — MR ONLY.
// This is the PRICE_STOCK_LOOKUP step that replaces the SALESMAN's TAKING_ORDER step for an
// MR. Order-taking is SALESMAN-exclusive, so an MR gets informational access to regional
// price tiers and branch ATP stock (for medical-detailing consultation) — but NOTHING that
// mutates state: no cart, no quantity entry, no add/submit actions anywhere in this SFC.
//
// Defense in depth: even though the hub only mounts this step for an MR, the component
// renders a read-only notice (and no lookup UI) when the user is not an MR, mirroring the
// `useRoleGuard` role gate. It reuses the same lini-scoped `MasterMaterial[]` catalog the
// sibling steps receive from the hub (loaded from the offline, lini-filtered Dexie cache),
// then reads price/stock on demand through `useApiClient.get`, which transparently falls
// back to a cached resolver when the device is offline. Forced light mode (no dark:
// variants); Nuxt UI + Tailwind tokens only.
import { computed, ref, watch } from 'vue'
import type { MasterMaterial, UserRole } from '@maction/types'
import { formatCurrency, formatDate } from '@maction/utils'
import { useApiClient } from '~/composables/useApiClient'
import { useOfflineDb } from '~/composables/useOfflineDb'
import { useRoleGuard } from '~/composables/useRoleGuard'
import type { MaterialPriceLookup, MaterialStockLookup } from '~/lib/in-visit/price-stock-types'

/** A material option projected for the `USelectMenu` (`id` value, `name` label). */
interface MaterialOption {
  id: string
  name: string
}

interface Props {
  /** Tenant of the consulting MR — scopes the offline cache lookups. */
  companyId: string
  /** Role of the current user — used to gate the lookup UI (MR only). */
  userRole: UserRole
  /** Optional sales office to scope regional price & branch stock to (from the MR's claims). */
  sofficeId?: string | null
  /** Lini-scoped material catalog for the picker (from the offline, lini-filtered cache). */
  materials?: MasterMaterial[]
}

const props = withDefaults(defineProps<Props>(), {
  sofficeId: null,
  materials: () => []
})

const api = useApiClient()
const offlineDb = useOfflineDb()
const { isMr } = useRoleGuard({ getRole: () => props.userRole })

const selectedMaterialId = ref<string | undefined>(undefined)
const price = ref<MaterialPriceLookup | null>(null)
const stockBatches = ref<MaterialStockLookup[]>([])
const loading = ref<boolean>(false)
/** Set when a lookup can't be resolved (e.g. offline with no cached price/stock). */
const lookupError = ref<string | null>(null)

/** Project lini-scoped materials into lightweight `{ id, name }` options for the picker. */
const materialOptions = computed<MaterialOption[]>(() =>
  props.materials.map(material => ({ id: material.id, name: material.name }))
)

/** The currently selected material, resolved from its id (drives the price/stock panels). */
const selectedMaterial = computed<MasterMaterial | undefined>(() =>
  props.materials.find(material => material.id === selectedMaterialId.value)
)

/**
 * UOM tiers for the selected material: its `base_uom` plus any additional units declared in
 * `uom_conversion_rules`, each with the number of base units it contains. Purely informational
 * — shows the Karton → Box → Strip → Pcs hierarchy the price tier is quoted against.
 */
const uomTiers = computed<Array<{ uom: string, baseUnits: number }>>(() => {
  const material = selectedMaterial.value
  if (!material) return []
  const rules = material.uom_conversion_rules ?? {}
  const uoms = Array.from(new Set([material.base_uom, ...Object.keys(rules)]))
  return uoms.map(uom => ({ uom, baseUnits: uom === material.base_uom ? 1 : (rules[uom] ?? 0) }))
})

/** Optional query scoping the price/stock lookup to the MR's sales office (branch). */
const lookupQuery = computed<Record<string, unknown> | undefined>(() =>
  props.sofficeId ? { soffice_id: props.sofficeId } : undefined
)

/** Total unrestricted ATP across all returned batches for the selected material. */
const totalAvailableQty = computed<number>(() =>
  stockBatches.value.reduce((sum, batch) => sum + batch.qty_available, 0)
)

/** The stock UOM (consistent across batches); falls back to the material base UOM. */
const stockUom = computed<string>(() =>
  stockBatches.value[0]?.uom ?? selectedMaterial.value?.base_uom ?? ''
)

/** Fetch the regional price for a material, degrading to `null` when unavailable. */
async function fetchPrice(materialId: string): Promise<MaterialPriceLookup | null> {
  const response = await api.get<{ data: MaterialPriceLookup }>(
    `/materials/${materialId}/price`,
    { query: lookupQuery.value, offlineFallback: () => ({ data: null as unknown as MaterialPriceLookup }) }
  )
  return response.data ?? null
}

/** Fetch branch ATP stock batches for a material, degrading to an empty list when unavailable. */
async function fetchStock(materialId: string): Promise<MaterialStockLookup[]> {
  const response = await api.get<{ data: MaterialStockLookup[] }>(
    `/materials/${materialId}/stock`,
    { query: lookupQuery.value, offlineFallback: () => ({ data: [] }) }
  )
  return response.data ?? []
}

/**
 * Load price + stock for the selected material. Reads are concurrent and independent, so a
 * missing price still shows available stock (and vice-versa). Confirms the material exists
 * in the offline cache first so a stale selection surfaces a clear "unavailable" message
 * rather than a raw error.
 */
async function loadDetails(materialId: string): Promise<void> {
  loading.value = true
  lookupError.value = null
  price.value = null
  stockBatches.value = []
  try {
    const cached = await offlineDb.getMaterial(props.companyId, materialId)
    if (!cached) {
      lookupError.value = 'Material tidak tersedia di katalog Anda.'
      return
    }
    const [priceResult, stockResult] = await Promise.all([
      fetchPrice(materialId),
      fetchStock(materialId)
    ])
    price.value = priceResult
    stockBatches.value = stockResult
    if (!priceResult && stockResult.length === 0) {
      lookupError.value = 'Harga & stok belum tersedia. Coba lagi saat kembali online.'
    }
  } catch {
    lookupError.value = 'Gagal memuat harga & stok. Silakan coba lagi.'
  } finally {
    loading.value = false
  }
}

// Load the price/stock panels whenever the selected material changes; clear them on deselect.
watch(selectedMaterialId, (materialId) => {
  if (!materialId) {
    price.value = null
    stockBatches.value = []
    lookupError.value = null
    return
  }
  void loadDetails(materialId)
})
</script>

<template>
  <!-- Defense in depth: only an MR sees the read-only lookup. -->
  <div
    v-if="!isMr"
    class="flex items-center gap-2 rounded-lg bg-elevated p-4 text-muted"
  >
    <UIcon
      name="i-lucide-info"
      class="size-5 shrink-0"
    />
    <p class="text-sm">
      Info harga &amp; stok hanya untuk Medical Representative.
    </p>
  </div>

  <div
    v-else
    class="flex flex-col gap-6"
  >
    <!-- Read-only banner: this step never mutates state. -->
    <div class="flex items-center gap-2 rounded-lg bg-primary-50 p-3 text-primary-700">
      <UIcon
        name="i-lucide-eye"
        class="size-5 shrink-0"
      />
      <p class="text-sm">
        Hanya lihat harga &amp; stok untuk konsultasi. Pengambilan order tidak tersedia untuk MR.
      </p>
    </div>

    <!-- Material picker with search (Nuxt UI USelectMenu is searchable by default). -->
    <UFormField label="Material">
      <USelectMenu
        v-model="selectedMaterialId"
        :items="materialOptions"
        value-key="id"
        label-key="name"
        searchable
        :disabled="materialOptions.length === 0"
        :placeholder="materialOptions.length === 0 ? 'Katalog belum tersedia' : 'Cari &amp; pilih material'"
        icon="i-lucide-pill"
        class="w-full"
      />
    </UFormField>

    <!-- Empty state before a material is chosen. -->
    <div
      v-if="!selectedMaterial"
      class="rounded-lg bg-elevated p-6 text-center text-sm text-muted"
    >
      Pilih material untuk melihat harga &amp; stok.
    </div>

    <template v-else>
      <!-- Selected material header. -->
      <div class="flex flex-col gap-1">
        <p class="text-base font-semibold">
          {{ selectedMaterial.name }}
        </p>
        <p class="text-xs text-muted">
          {{ selectedMaterial.code }} · Satuan dasar {{ selectedMaterial.base_uom }}
        </p>
      </div>

      <div
        v-if="loading"
        class="flex items-center justify-center gap-2 rounded-lg bg-elevated p-6 text-sm text-muted"
      >
        <UIcon
          name="i-lucide-loader-circle"
          class="size-5 animate-spin"
        />
        Memuat harga &amp; stok…
      </div>

      <div
        v-else-if="lookupError"
        class="flex items-center gap-2 rounded-lg bg-warning-50 p-4 text-warning-700"
      >
        <UIcon
          name="i-lucide-triangle-alert"
          class="size-5 shrink-0"
        />
        <p class="text-sm">
          {{ lookupError }}
        </p>
      </div>

      <template v-else>
        <!-- UOM tier reference (Karton → Box → Strip → Pcs). -->
        <div class="flex flex-col gap-2">
          <p class="text-sm font-medium">
            Satuan (UOM)
          </p>
          <ul class="flex flex-wrap gap-2">
            <li
              v-for="tier in uomTiers"
              :key="tier.uom"
            >
              <UBadge
                color="neutral"
                variant="soft"
                size="lg"
              >
                {{ tier.uom }} = {{ tier.baseUnits }} {{ selectedMaterial.base_uom }}
              </UBadge>
            </li>
          </ul>
        </div>

        <!-- Regional price panel. -->
        <div class="flex flex-col gap-3 rounded-lg border border-default p-4">
          <div class="flex items-center gap-2">
            <UIcon
              name="i-lucide-tag"
              class="size-4 text-muted"
            />
            <p class="text-sm font-medium">
              Harga Regional
            </p>
          </div>

          <div
            v-if="price"
            class="flex flex-col gap-2"
          >
            <p class="text-xs text-muted">
              Per {{ price.per }} {{ selectedMaterial.base_uom }} ({{ price.sales_uom }})
            </p>
            <div class="flex items-center justify-between text-sm">
              <span class="text-muted">Harga Reguler</span>
              <span class="font-semibold">{{ formatCurrency(price.price_regular) }}</span>
            </div>
            <div
              v-if="price.price_hja !== null"
              class="flex items-center justify-between text-sm"
            >
              <span class="text-muted">HJA</span>
              <span>{{ formatCurrency(price.price_hja) }}</span>
            </div>
            <div
              v-if="price.price_het !== null"
              class="flex items-center justify-between text-sm"
            >
              <span class="text-muted">HET</span>
              <span>{{ formatCurrency(price.price_het) }}</span>
            </div>
            <p class="text-xs text-muted">
              Berlaku {{ formatDate(price.valid_from) }} – {{ formatDate(price.valid_to) }}
            </p>
          </div>

          <p
            v-else
            class="text-sm text-muted"
          >
            Harga belum tersedia untuk material ini.
          </p>
        </div>

        <!-- Branch ATP stock panel (batch & SLED). -->
        <div class="flex flex-col gap-3 rounded-lg border border-default p-4">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <UIcon
                name="i-lucide-boxes"
                class="size-4 text-muted"
              />
              <p class="text-sm font-medium">
                Stok ATP
              </p>
            </div>
            <span
              v-if="stockBatches.length > 0"
              class="text-sm font-semibold"
            >
              {{ totalAvailableQty }} {{ stockUom }}
            </span>
          </div>

          <ul
            v-if="stockBatches.length > 0"
            class="flex flex-col gap-2"
          >
            <li
              v-for="batch in stockBatches"
              :key="batch.id"
              class="flex items-center justify-between gap-2 rounded-md bg-elevated p-3"
            >
              <div class="flex flex-col gap-0.5">
                <span class="text-sm font-medium">Batch {{ batch.batch }}</span>
                <span class="text-xs text-muted">
                  SLED: {{ batch.sled ? formatDate(batch.sled) : 'Tidak tercatat' }}
                </span>
              </div>
              <span class="text-sm">
                {{ batch.qty_available }} {{ batch.uom }}
              </span>
            </li>
          </ul>

          <p
            v-else
            class="text-sm text-muted"
          >
            Stok belum tersedia untuk material ini.
          </p>
        </div>
      </template>
    </template>
  </div>
</template>
