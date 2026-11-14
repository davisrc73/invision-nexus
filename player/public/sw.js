// Service Worker Offline-First Resiliente para Boxes Android X98 Plus (HTTP LAN & HTTPS)
const APP_SHELL_CACHE = 'invision-app-shell-v2';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', () => {
  // Pass-through transparente durante testes de desenvolvimento via HTTP LAN
});

