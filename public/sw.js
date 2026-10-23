// Makes Photobox installable as an app and keeps it usable on a weak connection.
// The app itself is fetched fresh when online and served from the cache when not.
// Thumbnails never change for a given ?v=, so they come from the cache first.
const SHELL = 'photobox-shell-v1';
const THUMBS = 'photobox-thumbs-v1';
const SHELL_FILES = ['/', '/app.js', '/style.css', '/manifest.webmanifest', '/icons/icon-192.png'];
const MAX_THUMBS = 3000;
const TRIM_EVERY = 100;

let added = 0;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== SHELL && key !== THUMBS) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin) return;
  if (/^\/api\/media\/\d+\/thumb$/.test(url.pathname)) event.respondWith(thumb(event.request));
  else if (!url.pathname.startsWith('/api/') && url.pathname !== '/photobox-ca.crt') event.respondWith(shell(event.request));
});

async function thumb(request) {
  const cache = await caches.open(THUMBS);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) {
    await cache.put(request, res.clone());
    if (++added % TRIM_EVERY === 0) trim(cache);
  }
  return res;
}

// Oldest first: cache keys come back in the order they were added.
async function trim(cache) {
  const keys = await cache.keys();
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_THUMBS))) await cache.delete(key);
}

async function shell(request) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(request);
    // A redirect means "pair first": don't let the pairing page replace the app in the cache.
    if (res.ok && !res.redirected) cache.put(request, res.clone());
    return res;
  } catch {
    return (await cache.match(request)) ?? (await cache.match('/')) ?? Response.error();
  }
}
