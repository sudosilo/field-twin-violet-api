// Field Twin Violet v1
// RED PHONE: service worker so the app opens with no signal. Built by Claude Code in the cloud session for Red Phone.
// Only same origin app files are cached. Supabase and the Railway API always go straight to the network.
const CACHE = "field-twin-violet-v1-1";
const SHELL = [
  "/",
  "/field-twin-violet-v1.html",
  "/field-twin-violet-v1.js",
  "/vendor/supabase.js",
  "/vendor/zxing.min.js",
  "/field-twin-violet.webmanifest",
  "/field-twin-violet-icon.svg",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  const key = url.pathname === "/" ? "/" : url.pathname;
  e.respondWith(
    caches.open(CACHE).then(async (c) => {
      const hit = await c.match(key);
      const net = fetch(e.request)
        .then((r) => {
          if (r.ok) c.put(key, r.clone());
          return r;
        })
        .catch(() => hit);
      return hit || net;
    })
  );
});
