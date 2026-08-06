// PERSONAL_VISIBLE_NAMES_V1
const CACHE_NAME = 'anafres-personal-folios-v1';
const APP_SHELL = [
  '/meseros/',
  '/meseros/index.html',
  '/meseros/meseros.js',
  '/meseros/correcciones-personal.css',
  '/meseros/manifest.webmanifest',
  '/meseros/icon-192.png',
  '/meseros/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key =>
            (
              key.startsWith('anafres-meseros-') ||
              key.startsWith('anafres-personal-')
            ) &&
            key !== CACHE_NAME
          )
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
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
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
        return response;
      })
      .catch(() =>
        caches.match(request)
          .then(match => match || caches.match('/meseros/'))
      )
  );
});
