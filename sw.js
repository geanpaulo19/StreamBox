/* ============================================================
   StreamBox — Service Worker  (sw.js)
   Scope   : / (tv.geanpaulo.com only — separate subdomain from EliteInvoice)
   Cache   : streambox-v1  (unique name — won't collide with other PWAs)

   Strategies:
     Static assets  → Cache First  (instant repeat loads)
     IPTV API JSON  → Network First (always try for fresh channel data)
     Live streams   → Bypass entirely (never cache .m3u8 / .mpd / .ts)
   ============================================================ */
'use strict';

const CACHE     = 'streambox-v1';
const SW_SCOPE  = self.registration.scope;  // https://tv.geanpaulo.com/

const PRECACHE = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.json',
  '/images/tvbox192.png',
  '/images/tvbox512.png',
];

/* Hosts whose responses should use Network-First */
const NETWORK_FIRST_HOSTS = [
  'iptv-org.github.io',
];

/* URL patterns that must NEVER be intercepted (live streams, DRM, fonts) */
const BYPASS_PATTERNS = [
  /\.m3u8(\?|$)/,
  /\.mpd(\?|$)/,
  /\.ts(\?|$)/,
  /\.aac(\?|$)/,
  /\.key(\?|$)/,
  /\/live\//,
  /\/hls\//,
  /\/dash\//,
  /akamaized\.net/,
  /googleapis\.com\/css/,   // Google Fonts CSS — let browser handle caching
  /gstatic\.com/,
];

/* ── Install ─────────────────────────────────────────────────── */
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

/* ── Activate: clean up old caches from previous SW versions ─── */
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => k !== CACHE && k.startsWith('streambox-'))
          .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* ── Fetch ───────────────────────────────────────────────────── */
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch { return; }

  /* Always bypass live stream & third-party resource requests */
  if (shouldBypass(url)) return;

  /* IPTV API → Network First */
  if (NETWORK_FIRST_HOSTS.some(h => url.hostname.includes(h))) {
    e.respondWith(networkFirst(req));
    return;
  }

  /* Same-origin static assets → Cache First */
  if (url.origin === SW_SCOPE.replace(/\/$/, '') || url.hostname === self.location.hostname) {
    e.respondWith(cacheFirst(req));
    return;
  }

  /* Everything else → passthrough (don't interfere) */
});

/* ── Caching strategies ──────────────────────────────────────── */
async function cacheFirst(req) {
  const cached = await caches.match(req, { ignoreSearch: false });
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res.ok && res.status < 400) {
      const cache = await caches.open(CACHE);
      cache.put(req, res.clone());
    }
    return res;
  } catch {
    /* Offline and not cached — return shell for navigation requests */
    if (req.mode === 'navigate') return caches.match('/index.html');
    return new Response('', { status: 503, statusText: 'Offline' });
  }
}

async function networkFirst(req) {
  try {
    const res = await Promise.race([
      fetch(req),
      new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 5000)),
    ]);
    if (res.ok) {
      const cache = await caches.open(CACHE);
      cache.put(req, res.clone());
    }
    return res;
  } catch {
    const cached = await caches.match(req);
    /* Return empty array so the app gracefully handles no data */
    return cached || new Response('[]', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

function shouldBypass(url) {
  return BYPASS_PATTERNS.some(p => p.test(url.href));
}
