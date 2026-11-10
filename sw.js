// Service worker: uygulama dosyalarını önbelleğe alır, böylece uygulama internetsiz açılır.
// Model dosyaları transformers.js tarafından ayrıca "transformers-cache" içinde saklanır.
// Claude API ve Hugging Face isteklerine dokunulmaz.

const VERSION = 'kd-v2';
const APP_FILES = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/db.js',
  './js/claude.js',
  './js/engine.js',
  './js/worker.js',
  './vendor/transformers.min.js',
  './vendor/anthropic.min.mjs',
  './vendor/ort-wasm-simd-threaded.mjs',
  './vendor/ort-wasm-simd-threaded.wasm',
  // WebGPU (deneysel) çekirdeği (.jsep, 22 MB) yalnızca kullanılırsa çalışma anında önbelleğe alınır.
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('kd-') && k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Önce ağ (güncel sürüm), ağ yoksa önbellek. Büyük vendor dosyaları için önce önbellek.
  const big = url.pathname.includes('/vendor/');
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    if (big) {
      const hit = await cache.match(e.request, { ignoreSearch: true });
      if (hit) return hit;
    }
    try {
      const res = await fetch(e.request);
      if (res.ok && res.type === 'basic') cache.put(e.request, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(e.request, { ignoreSearch: true }) || (e.request.mode === 'navigate' && await cache.match('./index.html'));
      if (hit) return hit;
      throw err;
    }
  })());
});
