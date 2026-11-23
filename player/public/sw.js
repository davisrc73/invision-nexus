// ============================================================================
// INVISION NEXUS — SERVICE WORKER OFFLINE-FIRST RESILIENTE PARA BOXES ANDROID
// Garante o carregamento do App Shell (HTML/JS/CSS) e recuperação offline
// mesmo após reinício a frio da Box X98 Plus sem qualquer ligação à rede.
// ============================================================================

const CACHE_NAME = 'invision-app-shell-v3';

const PRECACHE_SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest'
];

// Instalação: Pré-carrega o esqueleto HTML e manifest
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_SHELL).catch((err) => {
        console.warn('[SW] Pré-cache inicial parcial (prosseguindo):', err);
      });
    })
  );
});

// Ativação: Assume controlo imediato dos clientes e purga caches obsoletas
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME && key.startsWith('invision-app-shell')) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Interceção de Pedidos HTTP
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Apenas gere pedidos HTTP/HTTPS GET da mesma origem
  if (request.method !== 'GET' || !url.protocol.startsWith('http')) {
    return;
  }

  // 1. Pedidos de Navegação (Carregamento da página HTML do Player)
  // Estratégia: Network-First com fallback imediato para o index.html em cache se offline
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return networkResponse;
        })
        .catch(async () => {
          // Sem conectividade de rede: devolve o index.html da cache local persistente
          const cache = await caches.open(CACHE_NAME);
          const cachedIndex = (await cache.match('/index.html')) || (await cache.match('/'));
          if (cachedIndex) return cachedIndex;

          return new Response(
            '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="5"><title>Invision Nexus • Offline</title></head><body style="background:#000;color:#e1a924;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:system-ui,sans-serif;"><h1 style="color:#fff;margin-bottom:0.5rem;">INVISION NEXUS</h1><p style="color:#94a3b8;font-family:monospace;">A aguardar cache local...</p></body></html>',
            { headers: { 'Content-Type': 'text/html' } }
          );
        })
    );
    return;
  }

  // 2. Ficheiros Estáticos do App Shell (Bundles JS, CSS, Fontes, Ícones)
  // Estratégia: Cache-First com atualização em segundo plano (Stale-While-Revalidate)
  if (
    url.pathname.startsWith('/assets/') ||
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.css') ||
    url.pathname.endsWith('.woff2') ||
    url.pathname.endsWith('.svg') ||
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.webmanifest')
  ) {
    event.respondWith(
      caches.match(request).then((cachedResponse) => {
        const fetchPromise = fetch(request)
          .then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              const clone = networkResponse.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
            }
            return networkResponse;
          })
          .catch(() => {
            // Em modo offline, ignora falha de rede se já tivermos em cache
            return cachedResponse;
          });

        return cachedResponse || fetchPromise;
      })
    );
    return;
  }

  // 3. Chamadas de API REST (/api/v1/live/...)
  // Passam diretamente para a rede para que o Svelte ative o seu fallback determinístico de localStorage
});
