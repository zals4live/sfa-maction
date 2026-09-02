<script setup lang="ts">
import { reactive, ref } from 'vue'
import type { FormError, FormSubmitEvent } from '@nuxt/ui'
import { useAuthStore } from '~/stores/useAuthStore'

// Entry point for both SALESMAN & MR — deliberately no auth middleware.
definePageMeta({
  layout: 'auth'
})

const authStore = useAuthStore()
const toast = useToast()

// Reactive form state; the raw password lives only here and is never persisted.
const state = reactive<{ email: string, password: string }>({
  email: '',
  password: ''
})
const submitting = ref<boolean>(false)

// Basic email shape check — deferring heavier validation libraries to keep deps lean.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Required-field + email-format validation surfaced inline by UFormField. */
function validate(form: { email: string, password: string }): FormError[] {
  const errors: FormError[] = []
  if (!form.email) {
    errors.push({ name: 'email', message: 'Email wajib diisi' })
  } else if (!EMAIL_PATTERN.test(form.email)) {
    errors.push({ name: 'email', message: 'Format email tidak valid' })
  }
  if (!form.password) errors.push({ name: 'password', message: 'Kata sandi wajib diisi' })
  return errors
}

/** Authenticate via the store, then route to the app home on success. */
async function onSubmit(event: FormSubmitEvent<{ email: string, password: string }>): Promise<void> {
  submitting.value = true
  try {
    await authStore.login({ email: event.data.email, password: event.data.password })
    await navigateTo('/')
  } catch {
    // Never leak raw internals — show a generic, user-friendly message.
    toast.add({
      title: 'Gagal masuk',
      description: 'Email atau kata sandi salah. Silakan coba lagi.',
      color: 'error',
      icon: 'i-lucide-circle-alert'
    })
  } finally {
    submitting.value = false
  }
}

// Already-authenticated sessions (e.g. hydrated token) skip the login screen.
onMounted(async () => {
  if (authStore.isAuthenticated) await navigateTo('/')
})
</script>

<template>
  <div class="flex flex-col gap-6">
    <div class="flex flex-col gap-1 text-center">
      <h2 class="text-lg font-semibold text-highlighted">
        Masuk
      </h2>
      <p class="text-sm text-muted">
        Masuk untuk memulai aktivitas lapangan Anda
      </p>
    </div>

    <UForm
      :state="state"
      :validate="validate"
      class="flex flex-col gap-4"
      @submit="onSubmit"
    >
      <UFormField
        label="Email"
        name="email"
        required
      >
        <UInput
          v-model="state.email"
          type="email"
          autocomplete="email"
          placeholder="nama@kimiafarma.co.id"
          icon="i-lucide-mail"
          class="w-full"
        />
      </UFormField>

      <UFormField
        label="Kata Sandi"
        name="password"
        required
      >
        <UInput
          v-model="state.password"
          type="password"
          autocomplete="current-password"
          placeholder="Masukkan kata sandi"
          icon="i-lucide-lock"
          class="w-full"
        />
      </UFormField>

      <UButton
        type="submit"
        block
        size="lg"
        :loading="submitting"
        :disabled="submitting"
      >
        Masuk
      </UButton>
    </UForm>
  </div>
</template>
