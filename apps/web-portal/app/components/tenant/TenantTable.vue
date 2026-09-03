<script setup lang="ts">
/**
 * `TenantTable` — presentational CRUD table for the cross-tenant company list.
 *
 * Renders one row per tenant (`companies`) with code, name, branding summary (tax rate,
 * geofence radius), ERP system type, and active/inactive status, plus per-row actions:
 * edit (branding/identity), configure ERP gateway, and deactivate (kill-switch). It owns no
 * state — rows arrive via props and every action is emitted back for the parent to persist.
 * The deactivate action is hidden for already-inactive tenants. Forced Light Mode is global —
 * no `dark:` variants.
 */
import { h, resolveComponent } from 'vue'
import type { TableColumn } from '@nuxt/ui'
import type { TenantResponse } from '~/composables/useTenantAdmin'

const props = defineProps<{
  /** Tenant records to render (may be empty). */
  rows: TenantResponse[]
  /** Whether the table is currently loading/refreshing. */
  loading: boolean
  /** Empty-state message shown when there are no rows. */
  emptyLabel: string
}>()

const emit = defineEmits<{
  edit: [row: TenantResponse]
  erp: [row: TenantResponse]
  deactivate: [row: TenantResponse]
}>()

const UBadge = resolveComponent('UBadge')
const UButton = resolveComponent('UButton')

const columns: TableColumn<TenantResponse>[] = [
  {
    accessorKey: 'code',
    header: 'Kode',
    cell: ({ row }) => h('span', { class: 'font-medium text-highlighted' }, row.original.code)
  },
  {
    accessorKey: 'name',
    header: 'Nama Tenant',
    cell: ({ row }) => row.original.name
  },
  {
    accessorKey: 'default_tax_rate',
    header: 'PPN',
    cell: ({ row }) => `${row.original.default_tax_rate}%`
  },
  {
    accessorKey: 'geofence_radius_meters',
    header: 'Geofence',
    cell: ({ row }) => `${row.original.geofence_radius_meters} m`
  },
  {
    accessorKey: 'erp_system_type',
    header: 'ERP',
    cell: ({ row }) =>
      row.original.erp_system_type
        ? h(UBadge, { color: 'primary', variant: 'subtle', size: 'sm' }, () => row.original.erp_system_type)
        : h('span', { class: 'text-dimmed' }, 'Belum diatur')
  },
  {
    accessorKey: 'is_active',
    header: 'Status',
    cell: ({ row }) =>
      h(
        UBadge,
        {
          color: row.original.is_active ? 'success' : 'error',
          variant: 'subtle',
          size: 'sm'
        },
        () => (row.original.is_active ? 'Aktif' : 'Nonaktif')
      )
  },
  {
    id: 'actions',
    header: 'Aksi',
    cell: ({ row }) => {
      const actions = [
        h(UButton, {
          'icon': 'i-lucide-pencil',
          'color': 'neutral',
          'variant': 'ghost',
          'size': 'sm',
          'aria-label': 'Edit tenant',
          'onClick': () => emit('edit', row.original)
        }),
        h(UButton, {
          'icon': 'i-lucide-plug',
          'color': 'neutral',
          'variant': 'ghost',
          'size': 'sm',
          'aria-label': 'Konfigurasi ERP',
          'onClick': () => emit('erp', row.original)
        })
      ]
      if (row.original.is_active) {
        actions.push(
          h(UButton, {
            'icon': 'i-lucide-power-off',
            'color': 'error',
            'variant': 'ghost',
            'size': 'sm',
            'aria-label': 'Nonaktifkan tenant',
            'onClick': () => emit('deactivate', row.original)
          })
        )
      }
      return h('div', { class: 'flex justify-end gap-1' }, actions)
    }
  }
]
</script>

<template>
  <UTable
    :data="props.rows"
    :columns="columns"
    :loading="props.loading"
    loading-color="primary"
    :empty="props.emptyLabel"
    :ui="{ td: 'text-sm text-muted' }"
  />
</template>
