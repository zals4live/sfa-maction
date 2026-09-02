<script setup lang="ts">
// Presentational connectivity/sync status indicator (FR-PWA-07). A "dumb" component: the
// parent owns the sync source (`useBackgroundSync`) and passes the current `state` and
// `pendingCount` in as props, which keeps this trivially unit-testable. It renders the four
// connectivity states (Online / Offline / Syncing / Error) as an icon + label in a semantic
// color, plus a badge surfacing the pending-mutation backlog when there is one. The state →
// UI mapping is delegated to the shared `connectivityPresentation` helper (no duplicated
// mapping). Forced light mode (no dark: variants).
import { computed } from 'vue'
import type { ConnectivityState } from '@maction/types'
import { connectivityPresentation } from '../layouts/default.nav'

interface Props {
  /** Raw connectivity state from the background-sync source. */
  state: ConnectivityState
  /** Pending outbox backlog; a badge is shown only when greater than zero. */
  pendingCount: number
}

const props = defineProps<Props>()

// Map the raw state (+ backlog) into an icon, label, and semantic color token.
const status = computed(() => connectivityPresentation(props.state, props.pendingCount))
</script>

<template>
  <div
    class="flex items-center gap-1.5"
    role="status"
    aria-live="polite"
  >
    <UIcon
      :name="status.icon"
      :class="`size-4 text-${status.color}`"
    />
    <span :class="`text-xs font-medium text-${status.color}`">
      {{ status.label }}
    </span>
    <UBadge
      v-if="status.pendingCount > 0"
      :color="status.color"
      variant="subtle"
      size="sm"
    >
      {{ status.pendingCount }}
    </UBadge>
  </div>
</template>
