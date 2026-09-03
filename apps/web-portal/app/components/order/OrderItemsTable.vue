<script setup lang="ts">
/**
 * `OrderItemsTable` — renders an order's line items (qty, UOM, unit price, discount, subtotal).
 *
 * A presentational table used by the order detail/review view. Free-goods lines are flagged
 * with a badge and show a zero price. Material ids are shown mono/compact since the list
 * endpoint returns ids rather than resolved names (name resolution is a backend PDF concern).
 * Forced Light Mode is global — semantic color tokens only, no `dark:` variants.
 */
import type { OrderItemResponse } from '~/composables/useOrders'

defineProps<{
  items: OrderItemResponse[]
}>()

/** Format a rupiah amount as a compact currency string (no fractional cents). */
function formatCurrency(value: number): string {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0
  }).format(value)
}
</script>

<template>
  <div class="overflow-x-auto rounded-lg border border-default">
    <table class="w-full text-sm">
      <thead class="bg-elevated text-left text-xs font-medium text-muted">
        <tr>
          <th class="px-4 py-2.5">
            Material
          </th>
          <th class="px-4 py-2.5 text-right">
            Qty
          </th>
          <th class="px-4 py-2.5">
            UOM
          </th>
          <th class="px-4 py-2.5 text-right">
            Harga Satuan
          </th>
          <th class="px-4 py-2.5 text-right">
            Diskon
          </th>
          <th class="px-4 py-2.5 text-right">
            Subtotal
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="items.length === 0">
          <td
            class="px-4 py-6 text-center text-muted"
            colspan="6"
          >
            Tidak ada item pada pesanan ini.
          </td>
        </tr>
        <tr
          v-for="item in items"
          v-else
          :key="item.id"
          class="border-t border-default"
        >
          <td class="px-4 py-2.5">
            <div class="flex items-center gap-2">
              <span class="font-mono text-xs text-toned">{{ item.material_id }}</span>
              <UBadge
                v-if="item.is_free_goods"
                color="success"
                variant="soft"
                size="sm"
                icon="i-lucide-gift"
                label="Gratis"
              />
            </div>
          </td>
          <td class="px-4 py-2.5 text-right tabular-nums text-toned">
            {{ item.qty }}
          </td>
          <td class="px-4 py-2.5 text-toned">
            {{ item.uom }}
          </td>
          <td class="px-4 py-2.5 text-right tabular-nums text-toned">
            {{ formatCurrency(item.unit_price) }}
          </td>
          <td class="px-4 py-2.5 text-right tabular-nums text-toned">
            <span v-if="item.discount_amount > 0">
              {{ formatCurrency(item.discount_amount) }}
              <span class="text-dimmed">({{ item.discount_percentage.toFixed(0) }}%)</span>
            </span>
            <span v-else>—</span>
          </td>
          <td class="px-4 py-2.5 text-right font-medium tabular-nums text-highlighted">
            {{ formatCurrency(item.subtotal) }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
