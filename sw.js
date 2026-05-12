/* NeyoMarket Service Worker — PWA offline support */
const CACHE    = 'neyo-v1';
const OFFLINE  = '/';

/* Assets to cache on install */
const PRECACHE = [
  '/',
  '/index.html',
  'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;600;700&family=Outfit:wght@300;400;500;600;700&display=swap'
];

/* Install — cache core assets */
self.addEventListener('install', function(e) {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(function(cache) {
      return cache.addAll(PRECACHE).catch(function() {
        /* Non-fatal if some assets fail */
      });
    })
  );
});

/* Activate — clean old caches */
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE; })
            .map(function(k) { return caches.delete(k); })
      );
    }).then(function() { return self.clients.claim(); })
  );
});

/* Fetch — network first, cache fallback */
self.addEventListener('fetch', function(e) {
  /* Skip non-GET and API calls — always fresh */
  if (e.request.method !== 'GET') return;
  if (e.request.url.includes('/api/'))  return;
  if (e.request.url.includes('paystack')) return;

  e.respondWith(
    fetch(e.request)
      .then(function(response) {
        /* Cache successful responses */
        if (response && response.status === 200 && response.type === 'basic') {
          var clone = response.clone();
          caches.open(CACHE).then(function(cache) {
            cache.put(e.request, clone);
          });
        }
        return response;
      })
      .catch(function() {
        /* Offline fallback — serve cached version */
        return caches.match(e.request).then(function(cached) {
          return cached || caches.match(OFFLINE);
        });
      })
  );
});

