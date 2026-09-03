<script setup lang="ts">
/**
 * `KpiMetricCard` — a single executive KPI metric tile for the admin dashboard.
 *
 * Presentation-only: it renders one headline figure (active users, orders, revenue, …)
 * with a leading icon and an accent color drawn from the Nuxt UI semantic palette. It
 * owns no data fetching — the dashboard page passes already-resolved values in, keeping
 * the tile reusable across KPI sections. A `loading` flag renders a skeleton placeholder
 * so the grid keeps its shape during the initial fetch.
 *
 * Forced Light Mode is enforced globally (nuxt.config `colorMode`), so this component
 * intentionally uses no dark-mode classes or `dark:` variants.
 */

/** Semantic accent colors mapped to the Nuxt UI / KF Maction design tokens. */
type Accent = 'primary' | 'success' | 'warning' | 'error' | 'neutral'

const props = withDefaults(
  defineProps<{
    /** Card title (e.g. "Active Field Users"). */
    label: string
    /** Preformatted headline value (the parent formats numbers/currency). */
    value: string
    /** Leading icon name (Lucide, e.g. `i-lucide-users`). */
    icon: string
    /** Semantic accent applied to the icon chip. */
    accent?: Accent
    /** Optional supporting caption under the value. */
    caption?: string
    /** Render a skeleton placeholder instead of the value. */
    loading?: boolean
  }>(),
  {
    accent: 'primary',
    caption: undefined,
    loading: false
  }
)

// Static Tailwind class pairs per accent — kept as full literals so the JIT compiler
// can see every class (no dynamic string concatenation that Tailwind cannot detect).
const ACCENT_CLASSES: Record<Accent, string> = {
  primary: 'bg-primary-50 text-primary-600',
  success: 'bg-success-50 text-success-600',
  warning: 'bg-warning-50 text-warning-600',
  error: 'bg-error-50 text-error-600',
  neutral: 'bg-elevated text-muted'
}

const accentClass = computed<string>(() => ACCENT_CLASSES[props.accent])
</script>

<template>
  <UCard>
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <p class="text-sm font-medium text-muted truncate">
          {{ label }}
        </p>

        <USkeleton
          v-if="loading"
          class="mt-2 h-7 w-24"
        />
        <p
          v-else
          class="mt-1 text-2xl font-semibold text-highlighted tabular-nums truncate"
        >
          {{ value }}
        </p>

        <p
          v-if="caption && !loading"
          class="mt-1 text-xs text-dimmed truncate"
        >
          {{ caption }}
        </p>
      </div>

      <span
        class="flex size-10 shrink-0 items-center justify-center rounded-lg"
        :class="accentClass"
      >
        <UIcon
          :name="icon"
          class="size-5"
        />
      </span>
    </div>
  </UCard>
</template>
