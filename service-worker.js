/*
  Termac One — shared service worker
  Covers both PWA entry points (Termac One hub / Termac Tech field app) since
  they live on the same origin and share the same underlying data.

  Strategy:
  - App shell pages (termac-os.html, tech-portal.html, office-portal.html,
    scheduler-unipro.html, hr-portal.html, dispatcher-portal.html): NETWORK-FIRST,
    falling back to the last cached copy when offline. This matters because
    Ted ships fixes to these files daily — a cache-first strategy would leave
    field staff stuck on stale builds. Offline is the fallback, not the default.
  - Versioned CDN libraries (Chart.js, qrcodejs, Leaflet): CACHE-FIRST, since
    these are pinned by version number and never change underneath us.
  - AI proxy / live API calls (*.workers.dev): NEVER intercepted — always go
    straight to the network, no caching, no offline fallback (a cached AI
    response would be meaningless).
*/

const CACHE_VERSION = 'termac-one-v1';
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const LIB_CACHE = `${CACHE_VERSION}-libs`;

const SHELL_URLS = [
  'termac-os.html',
  'tech-portal.html',
  'office-portal.html',
  'scheduler-unipro.html',
  'hr-portal.html',
  'dispatcher-portal.html',
  'manifest-main.json',
  'manifest-tech.json',
  'icons/icon-main-192.png',
  'icons/icon-main-512.png',
  'icons/icon-main-maskable-192.png',
  'icons/icon-main-maskable-512.png',
  'icons/icon-main-apple-180.png',
  'icons/icon-tech-192.png',
  'icons/icon-tech-512.png',
  'icons/icon-tech-maskable-192.png',
  'icons/icon-tech-maskable-512.png',
  'icons/icon-tech-apple-180.png',
];

const LIB_URLS = [
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js',
  'https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700;800&family=Barlow:wght@400;500;600;700&display=swap',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const shellCache = await caches.open(SHELL_CACHE);
    // Loop + try/catch per URL rather than cache.addAll() -- one missing or
    // renamed file shouldn't block the whole install.
    await Promise.all(SHELL_URLS.map(async (url) => {
      try { await shellCache.add(url); } catch (e) { /* skip, will fetch live on first visit */ }
    }));
    const libCache = await caches.open(LIB_CACHE);
    await Promise.all(LIB_URLS.map(async (url) => {
      try { await libCache.add(url); } catch (e) { /* CDN unreachable at install time, skip */ }
    }));
  })());
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith('termac-one-') && k !== SHELL_CACHE && k !== LIB_CACHE)
        .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // never touch POST/PUT (form saves, AI proxy calls, etc.)

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  // Live API / AI proxy calls -- always network, never cached
  if (url.hostname.endsWith('workers.dev')) return;

  // Pinned CDN libraries -- cache-first
  if (LIB_URLS.includes(req.url)) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        const cache = await caches.open(LIB_CACHE);
        cache.put(req, res.clone());
        return res;
      } catch (e) {
        return cached || Response.error();
      }
    })());
    return;
  }

  // App shell navigations and known shell assets -- network-first, cache fallback
  const isShellAsset = SHELL_URLS.some((u) => req.url.endsWith(u));
  if (req.mode === 'navigate' || isShellAsset) {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        const cache = await caches.open(SHELL_CACHE);
        cache.put(req, res.clone());
        return res;
      } catch (e) {
        const cached = await caches.match(req);
        if (cached) return cached;
        // Last resort: offline, nothing cached for this exact page -- send
        // them to the hub shell rather than a browser error screen.
        const fallback = await caches.match('termac-os.html');
        return fallback || Response.error();
      }
    })());
  }
});
