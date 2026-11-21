// sw.js — PWA service worker. Naikkan CACHE_VERSION setiap kali frontend berubah (v2 -> v3 ...)
// agar cache lama dihapus saat activate dan pengguna tidak stuck di versi lama.
// Pakai path relatif agar kompatibel dengan GitHub Pages sub-path (mis. /wa-crm/).
const CACHE_VERSION = 'v2';
const CACHE_NAME = 'crm-shell-' + CACHE_VERSION;
const SHELL = ['./', './index.html', './app.js', './styles.css', './manifest.webmanifest', './config.js', './icon-192.png', './icon-512.png'];


self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // API tidak di-cache (butuh data segar + auth); hanya app shell yang cache-first.
  if (url.pathname.startsWith('/api/')) return;
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const fetchPromise = fetch(e.request).then((res) => {
        if (res && res.status === 200 && url.pathname !== '/sw.js') {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(e.request, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
