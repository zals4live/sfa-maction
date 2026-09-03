<script setup lang="ts">
// Auth layout — a minimal centered branded shell for the web-portal pre-session
// screens (e.g. /auth/login). Deliberately has no admin sidebar or navbar: it wraps
// unauthenticated pages only. Forced light mode (no dark: variants), primary token
// #1C4173 for KF branding.
</script>

<template>
  <div class="flex min-h-dvh flex-col items-center justify-center bg-muted px-4 py-10">
    <div class="flex w-full max-w-sm flex-col items-center gap-6">
      <div class="flex flex-col items-center gap-2 text-center">
        <UIcon
          name="i-lucide-activity"
          class="size-10 text-primary"
        />
        <h1 class="text-xl font-semibold text-primary">
          KF Maction
        </h1>
        <p class="text-sm text-muted">
          Admin Web Portal
        </p>
      </div>

      <UCard class="w-full">
        <slot />
      </UCard>
    </div>
  </div>
</template>
