/* Idea Vault Service Worker */
const CACHE_VERSION = "idea-vault-v1";
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const NAV_CACHE = `${CACHE_VERSION}-nav`;

const CORE_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    await cache.addAll(CORE_ASSETS);
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.map((k) => {
        if (!k.startsWith(CACHE_VERSION)) return caches.delete(k);
      })
    );
    self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle same-origin requests (GitHub Pages)
  if (url.origin !== self.location.origin) return;

  // Navigation: network-first, fallback to cached index.html
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(NAV_CACHE);
        cache.put(req, fresh.clone());
        return fresh;
      } catch {
        const cache = await caches.open(NAV_CACHE);
        const cachedNav = await cache.match(req);
        if (cachedNav) return cachedNav;
        const staticCache = await caches.open(STATIC_CACHE);
        return (await staticCache.match("./index.html")) || Response.error();
      }
    })());
    return;
  }

  // Static assets: cache-first
  event.respondWith((async () => {
    const cache = await caches.open(STATIC_CACHE);
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;

    try {
      const res = await fetch(req);
      // Cache successful basic responses
      if (res && res.ok && (res.type === "basic" || res.type === "default")) {
        cache.put(req, res.clone());
      }
      return res;
    } catch {
      // If it’s a request for something we don’t have cached, just fail gracefully
      return new Response("Offline", { status: 503, statusText: "Offline" });
    }
  })());
});
