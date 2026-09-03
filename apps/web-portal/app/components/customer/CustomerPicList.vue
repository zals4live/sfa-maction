<script setup lang="ts">
/**
 * `CustomerPicList` — presentational list of a customer's PIC (Person In Charge) contacts.
 *
 * Renders each contact from `master_pic` (name, position, phone) as a row, badging the
 * primary contact. It owns no state — the `pics` array arrives via props from the Customer
 * 360 page ({@link CustomerDetailResponse.pics}). An empty array renders a friendly empty
 * state rather than a blank block. Forced Light Mode is global — no `dark:` variants here.
 */
import type { PicResponse } from '~/composables/useCustomers'

defineProps<{
  /** PIC contacts for the customer (may be empty). */
  pics: PicResponse[]
}>()
</script>

<template>
  <div class="flex flex-col gap-2">
    <template v-if="pics.length > 0">
      <div
        v-for="pic in pics"
        :key="pic.id"
        class="flex items-center justify-between gap-3 rounded-lg border border-default p-3"
      >
        <div class="flex items-center gap-3">
          <UIcon
            name="i-lucide-user-round"
            class="size-5 text-muted"
          />
          <div class="flex flex-col">
            <span class="text-sm font-medium text-highlighted">{{ pic.pic_name }}</span>
            <span class="text-xs text-muted">{{ pic.position_title ?? 'Tanpa jabatan' }}</span>
          </div>
        </div>

        <div class="flex items-center gap-2">
          <UBadge
            v-if="pic.is_primary"
            color="primary"
            variant="subtle"
            size="sm"
            label="Utama"
          />
          <a
            v-if="pic.phone"
            :href="`tel:${pic.phone}`"
            class="inline-flex items-center gap-1 text-sm text-primary hover:underline"
          >
            <UIcon
              name="i-lucide-phone"
              class="size-4"
            />
            {{ pic.phone }}
          </a>
          <span
            v-else
            class="text-sm text-dimmed"
          >—</span>
        </div>
      </div>
    </template>

    <!-- Empty state -->
    <div
      v-else
      class="flex flex-col items-center gap-1 rounded-lg border border-dashed border-default p-6 text-muted"
    >
      <UIcon
        name="i-lucide-users"
        class="size-8"
      />
      <span class="text-sm">Belum ada kontak PIC</span>
    </div>
  </div>
</template>
