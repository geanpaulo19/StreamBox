/* ============================================================
   StreamBox — Service Worker
   Strategy:
     • Static assets (HTML, CSS, JS, fonts, images) → Cache First
     • IPTV API calls (channels/streams/countries JSON) → Network First
     • Everything else → Network with cache fallback
   ============================================================ */
'use strict';

const CACHE_NAME    = 'streambox-v1';
const CACHE_TIMEOUT = 4000; // ms before falling back to cache on slow networks

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.json',
  '/images/tvbox192.png',
  '/images/tvbox512.png',
];

const API_ORIGINS = [
  'iptv-org.github.io',
];

/* ── Install: pre-cache static assets ───────────────────────── */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

/* ── Activate: delete old caches ────────────────────────────── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

/* ── Fetch: routing strategy ─────────────────────────────────── */
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  /* Skip non-GET and cross-origin media/stream requests */
  if (request.method !== 'GET') return;
  if (isStreamUrl(url)) return;

  /* IPTV API → Network First (fresh data matters) */
  if (API_ORIGINS.some(o => url.hostname.includes(o))) {
    event.respondWith(networkFirst(request));
    return;
  }

  /* Static assets → Cache First */
  if (isStaticAsset(url)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  /* Default → Network with cache fallback */
  event.respondWith(networkWithFallback(request));
});

/* ── Strategies ──────────────────────────────────────────────── */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

async function networkFirst(request) {
  try {
    const response = await fetchWithTimeout(request, CACHE_TIMEOUT);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached || new Response('[]', {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function networkWithFallback(request) {
  try {
    return await fetch(request);
  } catch {
    const cached = await caches.match(request);
    return cached || caches.match('/index.html');
  }
}

function fetchWithTimeout(request, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    fetch(request).then(r => { clearTimeout(timer); resolve(r); }, reject);
  });
}

/* ── Helpers ─────────────────────────────────────────────────── */
function isStaticAsset(url) {
  return url.pathname.match(/\.(css|js|png|jpg|webp|svg|ico|woff2?|ttf)$/) ||
         url.pathname === '/' ||
         url.pathname === '/index.html';
}

function isStreamUrl(url) {
  /* Never intercept live stream or DRM requests */
  return url.pathname.match(/\.(m3u8|mpd|ts|aac|mp4|key)$/) ||
         url.pathname.includes('/live/') ||
         url.pathname.includes('/hls/') ||
         url.pathname.includes('/dash/');
}
