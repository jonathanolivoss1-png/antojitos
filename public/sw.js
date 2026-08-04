const CACHE_NAME = 'antojitos-shell-v1';

const APP_SHELL = [
  '/',
  '/index.html',
  '/admin/index.html',
  '/admin/admin.css',
  '/admin/admin.js',
  '/admin/catalog-admin.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/pwa.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .catch(() => null)
  );

  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      ))
  );

  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== 'GET') {
    return;
  }

  if (
    url.origin !== self.location.origin
  ) {
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(request));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          const copy = response.clone();

          caches.open(CACHE_NAME)
            .then(cache => cache.put(request, copy))
            .catch(() => null);

          return response;
        })
        .catch(async () => {
          return (
            await caches.match(request) ||
            await caches.match('/index.html')
          );
        })
    );

    return;
  }

  event.respondWith(
    caches.match(request)
      .then(cached => {
        if (cached) {
          return cached;
        }

        return fetch(request)
          .then(response => {
            if (
              response.ok &&
              response.type === 'basic'
            ) {
              const copy = response.clone();

              caches.open(CACHE_NAME)
                .then(cache => cache.put(request, copy))
                .catch(() => null);
            }

            return response;
          });
      })
  );
});

// NEW_ORDER_ALERTS_NOTIFICATION_CLICK_V1
self.addEventListener(
  'notificationclick',
  event => {
    event.notification.close();

    const targetUrl =
      event.notification?.data?.url ||
      '/admin/index.html';

    event.waitUntil(
      (async () => {
        const windows =
          await self.clients.matchAll({
            type: 'window',
            includeUncontrolled: true
          });

        for (const client of windows) {
          if (
            typeof client.navigate ===
            'function'
          ) {
            await client
              .navigate(targetUrl)
              .catch(() => {});
          }

          if (
            typeof client.focus ===
            'function'
          ) {
            return client.focus();
          }
        }

        if (
          self.clients.openWindow
        ) {
          return self.clients.openWindow(
            targetUrl
          );
        }

        return undefined;
      })()
    );
  }
);
