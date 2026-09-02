<script setup lang="ts">
// Baseline boot page. Feature pages (checkin, visits, orders, profile)
// are implemented in downstream Phase 12 tasks.
</script>

<template>
  <UContainer class="py-16">
    <div class="flex flex-col items-center gap-4 text-center">
      <UIcon
        name="i-lucide-map-pin"
        class="size-12 text-primary"
      />
      <h1 class="text-2xl font-semibold text-primary">
        KF Maction
      </h1>
      <p class="text-muted">
        Field Force PWA
      </p>
    </div>
  </UContainer>
</template>
