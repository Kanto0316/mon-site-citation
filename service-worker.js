// service-worker.js

const CACHE_NAME = 'blocnote-cache-v3';
const OFFLINE_PAGE = '/index.html';

// Liste des ressources à mettre en cache
const APP_SHELL = [
  OFFLINE_PAGE,
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap',
  'firebase-app-compat.js',
  'firebase-auth-compat.js',
  'firebase-firestore-compat.js'
];

self.addEventListener('install', event => {
  console.log('[SW] install');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  console.log('[SW] activate');
  event.waitUntil(self.clients.claim());
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.map(key => {
          if (key !== CACHE_NAME) {
            console.log('[SW] suppression ancien cache :', key);
            return caches.delete(key);
          }
        })
      )
    )
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;

  // 1) Si c'est une navigation (chargement de la page), renvoyer index.html depuis le cache
  if (request.mode === 'navigate') {
    event.respondWith(
      caches.match(OFFLINE_PAGE).then(cached => {
        if (cached) {
          console.log('[SW] page HTML servie depuis le cache');
          return cached;
        }
        return fetch(request).catch(err => {
          console.warn('[SW] échec réseau, renvoi index.html en fallback', err);
          return caches.match(OFFLINE_PAGE);
        });
      })
    );
    return;
  }

  // 2) Pour toutes les autres requêtes (CSS/JS/images/SDKs…)
  event.respondWith(
    caches.match(request).then(cachedResponse => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(request).then(networkResponse => {
        if (
          !networkResponse ||
          networkResponse.status !== 200 ||
          networkResponse.type !== 'basic'
        ) {
          return networkResponse;
        }
        const clone = networkResponse.clone();
        caches.open(CACHE_NAME).then(cache => {
          cache.put(request, clone);
        });
        return networkResponse;
      }).catch(err => {
        console.warn('[SW] échec fetch, ressource non trouvée dans le cache et hors ligne', err);
        return caches.match(OFFLINE_PAGE);
      });
    })
  );
});
