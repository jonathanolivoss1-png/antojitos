'use strict';

const CACHE_NAME =
  'anafres-cocina-cambios-v2';

const APP_SHELL = [
  '/cocina/',
  '/cocina/index.html',
  '/cocina/cocina.css?v=cambios-detallados-v1',
  '/cocina/cocina.js?v=cambios-detallados-v1',
  '/cocina/manifest.webmanifest',
  '/cocina/icon-192.png',
  '/cocina/icon-512.png'
];

self.addEventListener(
  'install',
  event => {
    event.waitUntil(
      caches
        .open(CACHE_NAME)
        .then(cache =>
          cache.addAll(APP_SHELL)
        )
        .then(() =>
          self.skipWaiting()
        )
    );
  }
);

self.addEventListener(
  'activate',
  event => {
    event.waitUntil(
      caches
        .keys()
        .then(keys =>
          Promise.all(
            keys
              .filter(key =>
                key.startsWith(
                  'anafres-cocina-'
                ) &&
                key !== CACHE_NAME
              )
              .map(key =>
                caches.delete(key)
              )
          )
        )
        .then(() =>
          self.clients.claim()
        )
    );
  }
);

self.addEventListener(
  'fetch',
  event => {
    const request = event.request;
    const url = new URL(request.url);

    if (
      request.method !== 'GET' ||
      url.origin !== self.location.origin ||
      url.pathname.startsWith('/api/')
    ) {
      return;
    }

    event.respondWith(
      fetch(request)
        .then(response => {
          const clone =
            response.clone();

          void caches
            .open(CACHE_NAME)
            .then(cache =>
              cache.put(
                request,
                clone
              )
            );

          return response;
        })
        .catch(() =>
          caches.match(request)
        )
    );
  }
);
