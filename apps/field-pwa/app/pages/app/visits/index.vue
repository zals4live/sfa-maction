<script setup lang="ts">
// Visit list page for BOTH field roles (SALESMAN & MR). Shows today's Monthly Visit Plan
// (MVP/SCP) with a per-visit lifecycle status badge. The page is intentionally thin: all data
// loading + status derivation lives in `useVisits`, role context in `useRoleGuard`, and the
// attendance gate in `useAttendanceStore`.
//   - Attendance lock (FR-ATT-04): when no valid check-in exists today, visit execution is
//     disabled and a notice directs the user to check in first (applies to SALESMAN & MR).
//   - Offline-first: plans + derived status come from the cache when offline (via useVisits).
// Forced light mode (no dark: variants).
import { computed, onMounted } from 'vue'
import { useVisits } from '~/composables/useVisits'
import { useAttendanceStore } from '~/stores/useAttendanceStore'
import { visitStatusPresentation } from '~/pages/app/visits/visit-status'

definePageMeta({
  layout: 'default'
})

const attendance = useAttendanceStore()
const visits = useVisits()

/** Visit execution is reachable only once a valid check-in exists for today. */
const isLocked = computed(() => attendance.isLocked)

/** Deep-link to the in-visit execution hub for a given plan (disabled while locked). */
function inVisitPath(planId: string): string {
  return `/app/visits/${planId}/in-visit`
}

onMounted(async () => {
  // Reflect an existing check-in so the lock notice is accurate on entry, then load plans.
  await attendance.fetchToday()
  await visits.load()
})
</script>

<template>
  <UContainer class="flex flex-col gap-5 py-5">
    <div class="flex flex-col gap-1">
      <h1 class="text-xl font-semibold text-primary">
        Kunjungan Hari Ini
      </h1>
      <p class="text-sm text-muted">
        Rencana kunjungan (MVP) Anda untuk hari ini beserta statusnya.
      </p>
    </div>

    <!-- Attendance lock notice (FR-ATT-04) — shown to SALESMAN & MR alike. -->
    <UAlert
      v-if="isLocked"
      icon="i-lucide-lock"
      color="warning"
      variant="subtle"
      title="Kunjungan terkunci"
      description="Lakukan check-in terlebih dahulu untuk memulai aktivitas kunjungan."
      :actions="[{ label: 'Absen Sekarang', color: 'warning', variant: 'solid', to: '/app/checkin' }]"
    />

    <!-- Load failure. -->
    <UAlert
      v-else-if="visits.error.value"
      icon="i-lucide-circle-alert"
      color="error"
      variant="subtle"
      title="Gagal memuat kunjungan"
      :description="visits.error.value"
    />

    <!-- Loading skeleton. -->
    <div
      v-if="visits.loading.value"
      class="flex flex-col gap-3"
    >
      <USkeleton
        v-for="n in 3"
        :key="n"
        class="h-20 w-full rounded-lg"
      />
    </div>

    <!-- Empty state: no plans scheduled for today. -->
    <UCard v-else-if="!visits.hasPlans.value">
      <div class="flex flex-col items-center gap-2 py-6 text-center text-muted">
        <UIcon
          name="i-lucide-calendar-x"
          class="size-10"
        />
        <p class="text-sm">
          Tidak ada rencana kunjungan untuk hari ini.
        </p>
      </div>
    </UCard>

    <!-- Visit plan rows with derived status badges. -->
    <ul
      v-else
      class="flex flex-col gap-3"
    >
      <li
        v-for="item in visits.items.value"
        :key="item.plan.id"
      >
        <UCard :ui="{ body: 'p-4' }">
          <div class="flex items-start justify-between gap-3">
            <div class="flex flex-col gap-1">
              <span class="text-sm font-semibold text-highlighted">
                {{ item.customerName }}
              </span>
              <span
                v-if="item.customerAddress"
                class="text-xs text-muted"
              >
                {{ item.customerAddress }}
              </span>
            </div>

            <UBadge
              :color="visitStatusPresentation(item.status).color"
              :icon="visitStatusPresentation(item.status).icon"
              variant="subtle"
              size="sm"
            >
              {{ visitStatusPresentation(item.status).label }}
            </UBadge>
          </div>

          <div class="mt-3 flex justify-end">
            <UButton
              size="sm"
              icon="i-lucide-navigation"
              :disabled="isLocked"
              :to="isLocked ? undefined : inVisitPath(item.plan.id)"
            >
              Mulai Kunjungan
            </UButton>
          </div>
        </UCard>
      </li>
    </ul>
  </UContainer>
</template>
