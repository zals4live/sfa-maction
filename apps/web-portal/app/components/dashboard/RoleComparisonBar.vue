<script setup lang="ts">
/**
 * `RoleComparisonBar` — a single Salesman-vs-MR comparison row rendered as two
 * horizontal bars sharing a common scale.
 *
 * The web-portal ships no charting library (only Leaflet for maps), so — per the
 * "lightweight, native-first" steering — segmented charts are built from plain CSS bars
 * whose widths are computed against the larger of the two values. This avoids a new
 * runtime dependency while giving an immediately legible visual comparison. Salesman
 * bars use the `primary` token, MR bars use `warning`, matching the dashboard legend.
 *
 * Presentation-only; values arrive already resolved from the parent. Forced Light Mode
 * is global, so no dark-mode classes or `dark:` variants appear here.
 */

const props = withDefaults(
  defineProps<{
    /** Row label (e.g. "Total Visits"). */
    label: string
    /** Salesman value for this metric. */
    salesman: number
    /** MR value for this metric. */
    mr: number
    /** Append a unit suffix to the displayed values (e.g. "%"). */
    suffix?: string
  }>(),
  {
    suffix: ''
  }
)

/** Largest non-zero value drives the shared bar scale; guards against divide-by-zero. */
const scale = computed<number>(() => Math.max(props.salesman, props.mr, 1))

/** Bar width as a clamped percentage of the shared scale. */
function widthPct(value: number): string {
  const pct = (value / scale.value) * 100
  return `${Math.max(0, Math.min(100, pct))}%`
}

/** Format a value with an optional unit suffix, using locale grouping for readability. */
function display(value: number): string {
  const formatted = Number.isInteger(value) ? value.toLocaleString('id-ID') : value.toFixed(1)
  return `${formatted}${props.suffix}`
}
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <p class="text-sm font-medium text-toned">
      {{ label }}
    </p>

    <div class="flex items-center gap-2">
      <span class="w-20 shrink-0 text-xs text-muted">Salesman</span>
      <div class="relative h-2.5 flex-1 overflow-hidden rounded-full bg-elevated">
        <div
          class="h-full rounded-full bg-primary-500 transition-all"
          :style="{ width: widthPct(salesman) }"
        />
      </div>
      <span class="w-16 shrink-0 text-right text-xs font-semibold text-highlighted tabular-nums">
        {{ display(salesman) }}
      </span>
    </div>

    <div class="flex items-center gap-2">
      <span class="w-20 shrink-0 text-xs text-muted">MR</span>
      <div class="relative h-2.5 flex-1 overflow-hidden rounded-full bg-elevated">
        <div
          class="h-full rounded-full bg-warning-500 transition-all"
          :style="{ width: widthPct(mr) }"
        />
      </div>
      <span class="w-16 shrink-0 text-right text-xs font-semibold text-highlighted tabular-nums">
        {{ display(mr) }}
      </span>
    </div>
  </div>
</template>
