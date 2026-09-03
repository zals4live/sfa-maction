<script setup lang="ts">
/**
 * `OrderStatusBadge` — renders an order's lifecycle status as a color-coded Nuxt UI badge.
 *
 * Centralizes the status → label/color/icon mapping so the order list and detail views stay
 * visually consistent. Statuses mirror PostgreSQL `order_status_enum`. Forced Light Mode is
 * global — semantic color tokens only, no `dark:` variants.
 */
import { computed } from 'vue'
import type { OrderStatusValue } from '~/composables/useOrders'

const props = defineProps<{
  status: OrderStatusValue
  size?: 'sm' | 'md' | 'lg'
}>()

/** Badge palette accepted by Nuxt UI components. */
type BadgeColor = 'primary' | 'secondary' | 'success' | 'info' | 'warning' | 'error' | 'neutral'

interface StatusMeta {
  label: string
  color: BadgeColor
  icon: string
}

/** Status → display metadata. Indonesian labels to match sibling admin pages. */
const STATUS_META: Record<OrderStatusValue, StatusMeta> = {
  DRAFT: { label: 'Draft', color: 'neutral', icon: 'i-lucide-file-pen' },
  SUBMITTED: { label: 'Diajukan', color: 'info', icon: 'i-lucide-send' },
  SYNCED_ERP: { label: 'Tersinkron ERP', color: 'success', icon: 'i-lucide-circle-check' },
  REJECTED_ERP: { label: 'Ditolak ERP', color: 'error', icon: 'i-lucide-circle-x' },
  CANCELLED: { label: 'Dibatalkan', color: 'warning', icon: 'i-lucide-ban' }
}

const FALLBACK: StatusMeta = { label: 'Tidak Diketahui', color: 'neutral', icon: 'i-lucide-circle-help' }

const meta = computed<StatusMeta>(() => STATUS_META[props.status] ?? FALLBACK)
</script>

<template>
  <UBadge
    :color="meta.color"
    variant="subtle"
    :size="size ?? 'sm'"
    :icon="meta.icon"
    :label="meta.label"
  />
</template>
