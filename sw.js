const CACHE = "mundial-2026-v4";

const PRECACHE = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/assets/icons/icon-pink-192.png",
  "/assets/icons/icon-pink-512.png",
  "/assets/icons/icon-pink-32.png",
  "/assets/icons/icon-pink-180.png",
  "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Outfit:wght@500;600;700;800;900&family=Plus+Jakarta+Sans:wght@400;500;600;700;800;900&display=swap",
  "https://cdnjs.cloudflare.com/ajax/libs/ical.js/1.5.0/ical.min.js",
];

const API_RE  = /^\/api\//;
const FEED_RE = /\.(ics|webcal)/;

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const { request } = e;
  const url = new URL(request.url);
  const isNavigation =
    request.mode === "navigate" ||
    url.pathname === "/" ||
    url.pathname === "/index.html";

  // Network-first para páginas, /api/* y feeds del calendario.
  if (isNavigation || url.pathname.match(API_RE) || FEED_RE.test(url.pathname) || url.searchParams.has("teams")) {
    e.respondWith(
      fetch(request)
        .then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(request, clone));
          }
          return res;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Cache-first para todo lo demás (shell, fuentes, iconos)
  e.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(res => {
        if (res.ok && (url.origin === self.location.origin || url.hostname.includes("fonts.g") || url.hostname.includes("cdnjs"))) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(request, clone));
        }
        return res;
      });
    })
  );
});
