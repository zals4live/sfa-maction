<script setup lang="ts">
/**
 * `AssignmentMatrix` — the doctor-outlet affiliation matrix (presentational).
 *
 * Renders a doctor's practice-outlet affiliations (`doctor_outlet_assignments`) as a table:
 * outlet, room/department, practice window, primary-practice badge, and active status, with
 * per-row edit/delete actions. It owns no state — the `assignments` array arrives via props
 * from the doctor 360 page, and edit/delete are emitted back for the parent to persist.
 *
 * An empty list renders a friendly empty state rather than a bare table. Forced Light Mode is
 * global — no `dark:` variants.
 */
import { h, resolveComponent } from 'vue'
import type { TableColumn } from '@nuxt/ui'
import type { DoctorAssignmentResponse } from '~/composables/useDoctors'

defineProps<{
  /** Affiliation rows to render (may be empty). */
  assignments: DoctorAssignmentResponse[]
  /** Whether the matrix is currently loading/refreshing. */
  loading: boolean
}>()

const emit = defineEmits<{
  edit: [assignment: DoctorAssignmentResponse]
  delete: [assignment: DoctorAssignmentResponse]
}>()

const UBadge = resolveComponent('UBadge')
const UButton = resolveComponent('UButton')

/** Compact "days · start–end" practice window, or a dash when nothing is scheduled. */
function practiceWindow(assignment: DoctorAssignmentResponse): string {
  const parts: string[] = []
  if (assignment.practice_days) parts.push(assignment.practice_days)
  if (assignment.practice_hours_start && assignment.practice_hours_end) {
    parts.push(`${assignment.practice_hours_start}–${assignment.practice_hours_end}`)
  }
  return parts.length > 0 ? parts.join(' · ') : '—'
}

const columns: TableColumn<DoctorAssignmentResponse>[] = [
  {
    id: 'outlet',
    header: 'Outlet',
    cell: ({ row }) => {
      const name = row.original.outlet?.name ?? 'Outlet tidak diketahui'
      const badge = row.original.is_primary_practice
        ? h(UBadge, { color: 'primary', variant: 'subtle', size: 'sm', label: 'Utama' })
        : null
      return h('div', { class: 'flex items-center gap-2' }, [
        h('span', { class: 'font-medium text-highlighted' }, name),
        badge
      ])
    }
  },
  {
    id: 'room',
    header: 'Ruang / Departemen',
    cell: ({ row }) => row.original.room_or_department ?? '—'
  },
  {
    id: 'window',
    header: 'Jadwal Praktik',
    cell: ({ row }) => practiceWindow(row.original)
  },
  {
    id: 'status',
    header: 'Status',
    cell: ({ row }) =>
      h(
        UBadge,
        {
          color: row.original.is_active ? 'success' : 'neutral',
          variant: 'subtle',
          size: 'sm'
        },
        () => (row.original.is_active ? 'Aktif' : 'Nonaktif')
      )
  },
  {
    id: 'actions',
    header: 'Aksi',
    cell: ({ row }) =>
      h('div', { class: 'flex justify-end gap-1' }, [
        h(UButton, {
          'icon': 'i-lucide-pencil',
          'color': 'neutral',
          'variant': 'ghost',
          'size': 'sm',
          'aria-label': 'Edit afiliasi',
          'onClick': () => emit('edit', row.original)
        }),
        h(UButton, {
          'icon': 'i-lucide-trash-2',
          'color': 'error',
          'variant': 'ghost',
          'size': 'sm',
          'aria-label': 'Hapus afiliasi',
          'onClick': () => emit('delete', row.original)
        })
      ])
  }
]
</script>

<template>
  <UTable
    :data="assignments"
    :columns="columns"
    :loading="loading"
    loading-color="primary"
    empty="Belum ada afiliasi outlet praktik."
    :ui="{ td: 'text-sm text-muted' }"
  />
</template>
