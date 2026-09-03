<script setup lang="ts">
/**
 * `CustomerAffiliations` — presentational list of a customer's doctor-outlet affiliations.
 *
 * For a Doctor customer, each row is an affiliated practice outlet (sourced from
 * `doctor_outlet_assignments` via `GET /doctors/:id/assignments`), showing the outlet name,
 * room/department, practice window, and a primary-practice badge. It owns no state — the
 * `assignments` array arrives via props from the Customer 360 page.
 *
 * The backend exposes affiliations only in the doctor→outlet direction, so an Outlet customer
 * has no reverse endpoint; the page passes an empty list and this component renders the
 * appropriate empty state via the `emptyLabel` prop. Forced Light Mode is global.
 */
import type { DoctorAssignmentResponse } from '~/composables/useDoctors'

defineProps<{
  /** Affiliation rows to render (empty when none / not applicable for this customer type). */
  assignments: DoctorAssignmentResponse[]
  /** Message shown when there are no affiliations to display. */
  emptyLabel: string
}>()

/** Compact "days · start–end" practice window, or a dash when nothing is scheduled. */
function practiceWindow(assignment: DoctorAssignmentResponse): string {
  const parts: string[] = []
  if (assignment.practice_days) parts.push(assignment.practice_days)
  if (assignment.practice_hours_start && assignment.practice_hours_end) {
    parts.push(`${assignment.practice_hours_start}–${assignment.practice_hours_end}`)
  }
  return parts.length > 0 ? parts.join(' · ') : '—'
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <template v-if="assignments.length > 0">
      <div
        v-for="assignment in assignments"
        :key="assignment.id"
        class="flex items-start justify-between gap-3 rounded-lg border border-default p-3"
      >
        <div class="flex items-start gap-3">
          <UIcon
            name="i-lucide-hospital"
            class="mt-0.5 size-5 text-muted"
          />
          <div class="flex flex-col">
            <span class="text-sm font-medium text-highlighted">
              {{ assignment.outlet?.name ?? 'Outlet tidak diketahui' }}
            </span>
            <span class="text-xs text-muted">
              {{ assignment.room_or_department ?? 'Tanpa ruang/departemen' }}
            </span>
            <span class="text-xs text-dimmed">{{ practiceWindow(assignment) }}</span>
          </div>
        </div>

        <UBadge
          v-if="assignment.is_primary_practice"
          color="primary"
          variant="subtle"
          size="sm"
          label="Praktik Utama"
        />
      </div>
    </template>

    <!-- Empty state -->
    <div
      v-else
      class="flex flex-col items-center gap-1 rounded-lg border border-dashed border-default p-6 text-muted"
    >
      <UIcon
        name="i-lucide-link-2-off"
        class="size-8"
      />
      <span class="text-sm text-center">{{ emptyLabel }}</span>
    </div>
  </div>
</template>
