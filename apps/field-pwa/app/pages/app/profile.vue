<script setup lang="ts">
// Profile & settings page — shared by BOTH field roles (SALESMAN & MR), reached via the
// "Profil" bottom-nav tab (`/app/profile`). The page is deliberately thin: it reads the
// decoded session from `useAuthStore` (getters derived from JWT claims — never decodes a
// token itself) and derives the role badge from `useRoleGuard`. It surfaces identity/tenant
// context (user, branch, business lines), basic app info (version), and a confirmed Logout
// action that clears the session and returns to the login screen.
// Forced light mode (no dark: variants); Indonesian copy.
import { computed, ref } from 'vue'
import { UserRole } from '@maction/types'
import { useAuthStore } from '~/stores/useAuthStore'
import { useRoleGuard } from '~/composables/useRoleGuard'

definePageMeta({
  layout: 'default'
})

const auth = useAuthStore()
const roleGuard = useRoleGuard({ getRole: () => auth.role })
const runtimeConfig = useRuntimeConfig()

// --- Local UI state ------------------------------------------------------------------------
/** Controls the logout confirmation modal. */
const isLogoutModalOpen = ref<boolean>(false)
/** True while the logout request/cleanup is in flight. */
const loggingOut = ref<boolean>(false)

// --- Derived display state -----------------------------------------------------------------
/** App version, sourced from runtime config with a static fallback. */
const appVersion = computed<string>(
  () => (runtimeConfig.public as { appVersion?: string }).appVersion ?? '2.0.0'
)

/** Role badge presentation (label + semantic color) for SALESMAN vs MR. */
const roleBadge = computed<{ label: string, color: 'primary' | 'success' }>(() => {
  if (roleGuard.isSalesman.value) return { label: 'Salesman', color: 'primary' }
  if (roleGuard.isMr.value) return { label: 'Medical Representative', color: 'success' }
  return { label: 'Peran tidak diketahui', color: 'primary' }
})

/** Two-letter avatar initials derived from the role (identity is a UUID, not a name). */
const avatarInitials = computed<string>(() =>
  roleGuard.role.value === UserRole.MR ? 'MR' : 'SL'
)

/** Number of business lines assigned to the field user. */
const liniCount = computed<number>(() => auth.liniIds.length)

// --- Functions -----------------------------------------------------------------------------
/** Open the logout confirmation dialog. */
function requestLogout(): void {
  isLogoutModalOpen.value = true
}

/** Clear the session (best-effort server notify) then return to the login screen. */
async function confirmLogout(): Promise<void> {
  loggingOut.value = true
  try {
    await auth.logout()
    await navigateTo('/auth/login')
  } finally {
    loggingOut.value = false
    isLogoutModalOpen.value = false
  }
}
</script>

<template>
  <UContainer class="flex flex-col gap-5 py-5">
    <div class="flex flex-col gap-1">
      <h1 class="text-xl font-semibold text-primary">
        Profil
      </h1>
      <p class="text-sm text-muted">
        Informasi akun dan pengaturan aplikasi Anda.
      </p>
    </div>

    <!-- No active session (defensive — the app shell normally guards this route). -->
    <UAlert
      v-if="!auth.profile"
      icon="i-lucide-user-x"
      color="warning"
      variant="subtle"
      title="Sesi tidak ditemukan"
      description="Silakan masuk kembali untuk melihat profil Anda."
    />

    <template v-else>
      <!-- Identity header -->
      <UCard>
        <div class="flex items-center gap-4">
          <UAvatar
            :text="avatarInitials"
            size="lg"
            :ui="{ root: 'bg-primary/10 text-primary' }"
          />
          <div class="flex flex-col gap-1.5">
            <UBadge
              :color="roleBadge.color"
              variant="subtle"
              icon="i-lucide-id-card"
            >
              {{ roleBadge.label }}
            </UBadge>
            <span class="font-mono text-xs text-muted">
              {{ auth.userId }}
            </span>
          </div>
        </div>
      </UCard>

      <!-- Account & tenant context -->
      <UCard>
        <template #header>
          <div class="flex items-center gap-2">
            <UIcon
              name="i-lucide-building-2"
              class="size-5 text-primary"
            />
            <h2 class="text-sm font-semibold text-highlighted">
              Informasi Akun
            </h2>
          </div>
        </template>

        <div class="flex flex-col gap-3">
          <div class="flex items-center justify-between gap-2">
            <span class="text-sm text-muted">Peran</span>
            <span class="text-sm font-medium text-highlighted">
              {{ roleBadge.label }}
            </span>
          </div>

          <div class="flex items-center justify-between gap-2">
            <span class="text-sm text-muted">Cabang</span>
            <span class="font-mono text-xs text-highlighted">
              {{ auth.sofficeId ?? '—' }}
            </span>
          </div>

          <div class="flex items-center justify-between gap-2">
            <span class="text-sm text-muted">Perusahaan</span>
            <span class="font-mono text-xs text-highlighted">
              {{ auth.companyId ?? '—' }}
            </span>
          </div>

          <div class="flex items-center justify-between gap-2">
            <span class="text-sm text-muted">Lini Bisnis</span>
            <UBadge
              color="primary"
              variant="subtle"
              icon="i-lucide-layers"
            >
              {{ liniCount }} lini
            </UBadge>
          </div>

          <div
            v-if="liniCount > 0"
            class="flex flex-wrap gap-1.5"
          >
            <UBadge
              v-for="liniId in auth.liniIds"
              :key="liniId"
              color="neutral"
              variant="outline"
              size="sm"
              class="font-mono"
            >
              {{ liniId }}
            </UBadge>
          </div>
        </div>
      </UCard>

      <!-- App / settings info -->
      <UCard>
        <template #header>
          <div class="flex items-center gap-2">
            <UIcon
              name="i-lucide-settings"
              class="size-5 text-primary"
            />
            <h2 class="text-sm font-semibold text-highlighted">
              Pengaturan Aplikasi
            </h2>
          </div>
        </template>

        <div class="flex items-center justify-between gap-2">
          <span class="text-sm text-muted">Versi Aplikasi</span>
          <span class="text-sm font-medium text-highlighted">
            v{{ appVersion }}
          </span>
        </div>
      </UCard>

      <!-- Logout -->
      <UButton
        block
        size="lg"
        color="error"
        variant="soft"
        icon="i-lucide-log-out"
        :loading="loggingOut"
        @click="requestLogout"
      >
        Keluar
      </UButton>

      <!-- Logout confirmation -->
      <UModal
        v-model:open="isLogoutModalOpen"
        title="Keluar dari akun?"
        description="Anda perlu masuk kembali untuk melanjutkan aktivitas lapangan."
      >
        <template #footer>
          <div class="flex w-full justify-end gap-2">
            <UButton
              color="neutral"
              variant="outline"
              :disabled="loggingOut"
              @click="isLogoutModalOpen = false"
            >
              Batal
            </UButton>
            <UButton
              color="error"
              icon="i-lucide-log-out"
              :loading="loggingOut"
              @click="confirmLogout"
            >
              Keluar
            </UButton>
          </div>
        </template>
      </UModal>
    </template>
  </UContainer>
</template>
