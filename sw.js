const CACHE_NAME = 'agendaUp-cache-v1';
const urlsToCache = [
  '/',
  '/index.html',
  '/dashboard.html',
  '/booking.html',
  '/images/icons/icon-192x192.png',
  '/images/icons/icon-512x512.png',
  '/css/styles.css', // se houver um arquivo CSS separado
  '/js/app.js' // se houver um arquivo JavaScript separado
];

// Instalando o Service Worker e armazenando os arquivos em cache
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(urlsToCache))
  );
});

// Ativando o Service Worker e removendo caches antigos
self.addEventListener('activate', (event) => {
  const cacheWhitelist = [CACHE_NAME];
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (!cacheWhitelist.includes(cacheName)) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});

// Interceptando as requisições para servir arquivos do cache
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request)
      .then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }
        return fetch(event.request);
      })
  );
});
