// Service worker: offline app shell. It never caches the Bridge API, WebSocket traffic, provider responses or keys.
const VERSION = "dfx-shell-v0.1.0";
const SHELL = [
  "/", "/index.html", "/manifest.webmanifest",
  "/src/styles/tokens.css", "/src/styles/base.css", "/src/styles/layout.css", "/src/styles/editor.css", "/src/styles/chat.css",
  "/src/main.js", "/public/icons/icon-192.png", "/public/icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => Promise.allSettled(SHELL.map((u) => c.add(u)))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api") || url.pathname === "/ws") return;
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const cached = await cache.match(req);
    const network = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
    if (cached) { network.catch(() => {}); return cached; }        // stale-while-revalidate
    return (await network) || (req.mode === "navigate" ? await cache.match("/") : null) || new Response("offline", { status: 503 });
  })());
});
