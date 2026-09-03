<script setup lang="ts">
/**
 * `MasterDataTable` — presentational CRUD table for a lini or varian list.
 *
 * Lini (`master_lini`) and varian (`master_varian`) render with the same columns (code, name,
 * description, status) and per-row edit/soft-delete actions, so a single generic table serves
 * both. It owns no state — rows arrive via props and edit/delete are emitted back for the
 * parent to persist. Forced Light Mode is global — no `dark:` variants.
 */
import { h, resolveComponent } from 'vue'
import type { TableColumn } from '@nuxt/ui'

/** The minimal record shape shared by lini and varian rows. */
interface MasterRow {
  id: string
  code: string
  name: string
  description: string | null
  is_active: boolean
}

const props = defineProps<{
  /** Records to render (may be empty). */
  rows: MasterRow[]
  /** Whether the table is currently loading/refreshing. */
  loading: boolean
  /** Empty-state message shown when there are no rows. */
  emptyLabel: string
}>()

const emit = defineEmits<{
  edit: [row: MasterRow]
  delete: [row: MasterRow]
}>()

const UBadge = resolveComponent('UBadge')
const UButton = resolveComponent('UButton')

const columns: TableColumn<MasterRow>[] = [
  {
    accessorKey: 'code',
    header: 'Kode',
    cell: ({ row }) => h('span', { class: 'font-medium text-highlighted' }, row.original.code)
  },
  {
    accessorKey: 'name',
    header: 'Nama',
    cell: ({ row }) => row.original.name
  },
  {
    accessorKey: 'description',
    header: 'Deskripsi',
    cell: ({ row }) => row.original.description ?? '—'
  },
  {
    accessorKey: 'is_active',
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
          'aria-label': 'Edit',
          'onClick': () => emit('edit', row.original)
        }),
        h(UButton, {
          'icon': 'i-lucide-trash-2',
          'color': 'error',
          'variant': 'ghost',
          'size': 'sm',
          'aria-label': 'Hapus',
          'onClick': () => emit('delete', row.original)
        })
      ])
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
