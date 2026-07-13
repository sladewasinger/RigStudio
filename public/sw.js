/**
 * D1: a MINIMAL app-shell service worker — installability, not offline perfection.
 * Registered ONLY in production builds (see ../src/pwa.ts — `import.meta.env.PROD`
 * gates registration, so the dev server, `npm run dev`'s HMR, and the interaction
 * suite never touch this file at all).
 *
 * What's cached, and how:
 *   - Navigations (`request.mode === 'navigate'`, i.e. loading/reloading the app) and
 *     hashed build assets under `/assets/` (Vite's default output — content-hashed
 *     filenames, so a new deploy is a new URL and cache-first is always safe there):
 *     CACHE-FIRST, falling back to network and re-caching the response.
 *   - Everything else (PIP_MASTER.svg, the manifest, any future API-ish fetch):
 *     NETWORK-FIRST, falling back to a prior cached copy when offline.
 * No build-time precache manifest (no workbox, no generated file list) — deliberately
 * simple per CLAUDE.md's "don't wire codegen into the build"; the shell is populated
 * lazily on first visit rather than precached on install.
 *
 * Never touches non-GET requests or cross-origin requests (the Claude API, etc.) —
 * both fall straight through to the network untouched.
 */

const CACHE = 'rig-studio-shell-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

function isShellRequest(req, url) {
  return req.mode === 'navigate' || url.pathname.includes('/assets/');
}

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res.ok) {
    const cache = await caches.open(CACHE);
    cache.put(req, res.clone());
  }
  return res;
}

async function networkFirst(req) {
  try {
    const res = await fetch(req);
    if (res.ok) {
      const cache = await caches.open(CACHE);
      cache.put(req, res.clone());
    }
    return res;
  } catch (err) {
    const cached = await caches.match(req);
    if (cached) return cached;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(isShellRequest(req, url) ? cacheFirst(req) : networkFirst(req));
});
