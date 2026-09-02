<script setup lang="ts">
// Auth layout — a centered branded card shell shared by SALESMAN & MR entry pages
// (e.g. /auth/login). Deliberately has no bottom navigation: it wraps the pre-session
// screens only. Forced light mode (no dark: variants) for outdoor readability.
</script>

<template>
  <div class="flex min-h-dvh flex-col items-center justify-center bg-muted px-4 py-10">
    <div class="flex w-full max-w-sm flex-col items-center gap-6">
      <div class="flex flex-col items-center gap-2 text-center">
        <UIcon
          name="i-lucide-map-pin"
          class="size-10 text-primary"
        />
        <h1 class="text-xl font-semibold text-primary">
          KF Maction
        </h1>
        <p class="text-sm text-muted">
          Field Force PWA
        </p>
      </div>

      <UCard class="w-full">
        <slot />
      </UCard>
    </div>
  </div>
</template>
