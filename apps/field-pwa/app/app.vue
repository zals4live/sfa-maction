<script setup lang="ts">
useHead({
  meta: [
    { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
    { name: 'theme-color', content: '#1C4173' },
    // iOS "Add to Home Screen" standalone install support.
    { name: 'mobile-web-app-capable', content: 'yes' },
    { name: 'apple-mobile-web-app-capable', content: 'yes' },
    // Forced Light Mode: keep the status bar light-content over the light theme.
    { name: 'apple-mobile-web-app-status-bar-style', content: 'default' },
    { name: 'apple-mobile-web-app-title', content: 'Maction' }
  ],
  link: [
    { rel: 'icon', href: '/favicon.ico' },
    // Home screen icon used by iOS Safari when installing the PWA.
    { rel: 'apple-touch-icon', href: '/apple-touch-icon.png', sizes: '180x180' }
  ],
  htmlAttrs: {
    lang: 'id'
  }
})

const title = 'KF Maction'
const description = 'KF Maction Field Force PWA'

useSeoMeta({
  title,
  description,
  ogTitle: title,
  ogDescription: description
})
</script>

<template>
  <UApp>
    <NuxtRouteAnnouncer />
    <NuxtPage />
  </UApp>
</template>
