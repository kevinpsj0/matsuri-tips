const CACHE = "matsuri-tips-v49";
const ASSETS = [
  "./",
  "./index.html",
  "./calc.js",
  "./i18n.js",
  "./today.html",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/icon.svg",
  "./admin.html",
  "./admin.js",
  "./admin.webmanifest",
  "./icons/icon-admin.svg",
  "./icons/icon-192-admin.png",
  "./icons/icon-512-admin.png",
  "./icons/apple-touch-icon-admin.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  // Let the form's submit (POST, cross-origin to Apps Script) go straight to the network.
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // Keep the pages and app logic fresh when online; fall back to cache offline.
  const freshFirst = req.mode === "navigate" || url.pathname.endsWith("/calc.js") || url.pathname.endsWith("/admin.js") || url.pathname.endsWith("/i18n.js");
  if (freshFirst) {
    e.respondWith(
      fetch(req, { cache: "reload" }) // bypass the HTTP cache so updates aren't masked by it
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(req, clone));
          return res;
        })
        .catch(() =>
          caches.match(req)
            .then((c) => c || (req.mode === "navigate" ? caches.match(url.pathname.includes("admin") ? "./admin.html" : url.pathname.includes("today") ? "./today.html" : "./index.html") : undefined))
            .then((c) => c || new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } }))
        )
    );
    return;
  }

  // Cache-first for static assets (icons, manifest).
  e.respondWith(
    caches.match(req).then((cached) =>
      cached ||
      fetch(req).then((res) => {
        if (res && res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(req, clone));
        }
        return res;
      })
    )
  );
});
