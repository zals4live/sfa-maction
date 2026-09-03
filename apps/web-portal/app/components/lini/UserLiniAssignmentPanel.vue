<script setup lang="ts">
/**
 * `UserLiniAssignmentPanel` — manage a field user's business-line assignments (M:N).
 *
 * Field users (SALESMAN / MR) only see materials scoped to their assigned business lines via
 * RLS, so this panel is how an admin grants or revokes that scope. The backend exposes no
 * user-directory endpoint, so the admin supplies the target user's id (UUID); the panel then
 * loads that user's current assignments (`GET /users/:id/lini`), lets the admin add one or more
 * unassigned lini in a single batch (`POST /users/:id/lini` with `{ lini_ids }`), and remove an
 * individual assignment (`DELETE /users/:id/lini/:liniId`).
 *
 * All state (the entered user id, loaded assignments, and the pending add-selection) lives here;
 * the API calls flow through {@link useLini}, passed in as a prop so the parent page owns a
 * single composable instance. Forced Light Mode is global — no `dark:` variants.
 */
import { computed, h, ref, resolveComponent } from 'vue'
import type { TableColumn } from '@nuxt/ui'
import type {
  LiniResponse,
  UseLiniApi,
  UserLiniAssignmentResponse
} from '~/composables/useLini'

const props = defineProps<{
  /** The shared lini composable instance owned by the parent page. */
  api: UseLiniApi
  /** All active business lines available to assign (the lini catalog). */
  liniCatalog: LiniResponse[]
}>()

const toast = useToast()

const UBadge = resolveComponent('UBadge')
const UButton = resolveComponent('UButton')

/** A `{ label, value }` picker option for the "add lini" multi-select. */
interface LiniOption {
  label: string
  value: string
}

// --- Local state ---
const userIdInput = ref<string>('')
/** The user id whose assignments are currently loaded (null before the first load). */
const loadedUserId = ref<string | null>(null)
const assignments = ref<UserLiniAssignmentResponse[]>([])
const loadingAssignments = ref<boolean>(false)
const mutating = ref<boolean>(false)
/** Lini ids selected in the add-picker, pending a batch assign. */
const pendingLiniIds = ref<string[]>([])

/** Rough UUID v4-ish validation so we do not query the backend with obvious garbage. */
const UUID_PATTERN
  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const isUserIdValid = computed<boolean>(() => UUID_PATTERN.test(userIdInput.value.trim()))

/** Ids of lini the loaded user already has, to exclude them from the add-picker. */
const assignedLiniIds = computed<Set<string>>(
  () => new Set(assignments.value.map(a => a.lini_id))
)

/** Options for the add-picker: active catalog lini the user is not already assigned. */
const availableOptions = computed<LiniOption[]>(() =>
  props.liniCatalog
    .filter(lini => lini.is_active && !assignedLiniIds.value.has(lini.id))
    .map(lini => ({ label: `${lini.code} — ${lini.name}`, value: lini.id }))
)

/** Load (or reload) the entered user's current lini assignments. */
async function loadAssignments(): Promise<void> {
  const userId = userIdInput.value.trim()
  if (!isUserIdValid.value) return
  loadingAssignments.value = true
  try {
    const result = await props.api.listUserLini(userId)
    assignments.value = result.data
    loadedUserId.value = userId
    pendingLiniIds.value = []
  } catch {
    toast.add({ title: 'Gagal memuat penugasan lini', color: 'error' })
  } finally {
    loadingAssignments.value = false
  }
}

/** Batch-assign the selected lini to the loaded user, then reload. */
async function onAssign(): Promise<void> {
  if (!loadedUserId.value || pendingLiniIds.value.length === 0) return
  mutating.value = true
  try {
    await props.api.assignUserLini(loadedUserId.value, pendingLiniIds.value)
    toast.add({ title: 'Lini ditugaskan', color: 'success' })
    await loadAssignments()
  } catch {
    toast.add({ title: 'Gagal menugaskan lini', color: 'error' })
  } finally {
    mutating.value = false
  }
}

/** Remove a single lini assignment from the loaded user, then reload. */
async function onRemove(assignment: UserLiniAssignmentResponse): Promise<void> {
  if (!loadedUserId.value) return
  mutating.value = true
  try {
    await props.api.removeUserLini(loadedUserId.value, assignment.lini_id)
    toast.add({ title: 'Penugasan dihapus', color: 'success' })
    await loadAssignments()
  } catch {
    toast.add({ title: 'Gagal menghapus penugasan', color: 'error' })
  } finally {
    mutating.value = false
  }
}

const columns: TableColumn<UserLiniAssignmentResponse>[] = [
  {
    accessorKey: 'lini_code',
    header: 'Kode Lini',
    cell: ({ row }) => h('span', { class: 'font-medium text-highlighted' }, row.original.lini_code)
  },
  {
    accessorKey: 'lini_name',
    header: 'Nama Lini',
    cell: ({ row }) => row.original.lini_name
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
      h('div', { class: 'flex justify-end' }, [
        h(UButton, {
          'icon': 'i-lucide-trash-2',
          'color': 'error',
          'variant': 'ghost',
          'size': 'sm',
          'aria-label': 'Hapus penugasan',
          'disabled': mutating.value,
          'onClick': () => onRemove(row.original)
        })
      ])
  }
]
</script>

<template>
  <div class="flex flex-col gap-6">
    <!-- User selector -->
    <div class="flex flex-col gap-2">
      <p class="text-sm text-muted">
        Masukkan ID pengguna (UUID) field force untuk mengelola penugasan lini bisnis mereka.
      </p>
      <div class="flex flex-wrap items-start gap-2">
        <UFormField
          name="user_id"
          class="grow"
          :error="userIdInput.length > 0 && !isUserIdValid ? 'Format UUID tidak valid.' : undefined"
        >
          <UInput
            v-model="userIdInput"
            icon="i-lucide-user"
            placeholder="ID pengguna (UUID)"
            class="w-full"
            @keyup.enter="loadAssignments"
          />
        </UFormField>
        <UButton
          icon="i-lucide-search"
          color="primary"
          label="Muat Penugasan"
          :loading="loadingAssignments"
          :disabled="!isUserIdValid"
          @click="loadAssignments"
        />
      </div>
    </div>

    <!-- Assignment management (only after a user is loaded) -->
    <template v-if="loadedUserId">
      <!-- Add lini -->
      <div class="flex flex-wrap items-end gap-2">
        <UFormField
          label="Tambah Lini"
          name="add_lini"
          class="grow"
        >
          <USelectMenu
            v-model="pendingLiniIds"
            :items="availableOptions"
            value-key="value"
            multiple
            searchable
            placeholder="Pilih lini untuk ditugaskan"
            class="w-full"
          />
        </UFormField>
        <UButton
          icon="i-lucide-plus"
          color="primary"
          label="Tugaskan"
          :loading="mutating"
          :disabled="pendingLiniIds.length === 0"
          @click="onAssign"
        />
      </div>

      <!-- Current assignments -->
      <div class="flex flex-col gap-2">
        <h3 class="text-sm font-semibold text-highlighted">
          Lini Tertugas
        </h3>
        <UTable
          :data="assignments"
          :columns="columns"
          :loading="loadingAssignments"
          loading-color="primary"
          empty="Pengguna ini belum memiliki penugasan lini."
          :ui="{ td: 'text-sm text-muted' }"
        />
      </div>
    </template>
  </div>
</template>
