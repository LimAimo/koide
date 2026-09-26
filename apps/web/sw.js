// Koide legacy service-worker cleanup.
// Older builds used a fixed cache name and stale-while-revalidate for the application shell.
// Keep this tiny worker temporarily so browsers that already installed the old worker can
// receive an update, purge its cache, unregister it, and reload onto uncached application files.

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith("dfx-shell-")).map((key) => caches.delete(key)));
    await self.clients.claim();
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    await self.registration.unregister();
    await Promise.all(windows.map((client) => client.navigate(client.url).catch(() => null)));
  })());
});
