/* Keeps the app working offline (flight mode, no wifi). Bump the version when you upload a new build.
   Works on any host: layoverlogbook.com (Cloudflare turns /app.html into /app with a redirect),
   the old github.io address, and the Android/Windows apps. */
const CACHE = "layover-v7.2";
const SHELL = ["./app.html", "./config.js", "./globe3d.js", "./earth.jpg", "./earth-water.png", "./postcards.js", "./together.js", "./fx3d.js", "./chat.js",
  "./analytics.js", "./consent.js", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png", "./apple-touch-icon.png",
  "./privacy-policy.html", "./politique-de-confidentialite.html", "./terms.html", "./conditions-generales.html",
  "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css"];
const APP = new URL("./app.html", self.registration.scope).href;

/* A page that arrived through a redirect can't be handed back to the browser as-is
   (it refuses it for page loads), so keep a clean copy. */
async function clean(res) {
  if (!res || !res.redirected) return res;
  const body = await res.blob();
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}
async function save(cache, req, res) {
  const c = await clean(res.clone());
  await cache.put(req, c.clone());
  if (res.redirected && res.url) await cache.put(res.url, c);   // also under the final address (/app)
}

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(cache => Promise.all(SHELL.map(u =>
    fetch(u, { cache: "reload" }).then(res => { if (res.ok) return save(cache, u, res); }).catch(() => {})   // one missing file never blocks the rest
  ))));
  self.skipWaiting();
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

async function offlinePage(req) {
  const c = await caches.open(CACHE);
  return (await c.match(req, { ignoreSearch: true }))
      || (await c.match(APP))
      || (await c.match(APP.replace(/\.html$/, "")))
      || new Response("<h1>You're offline</h1><p>Open Layover Logbook once with internet to use it offline.</p>",
                      { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

self.addEventListener("fetch", e => {
  const r = e.request; if (r.method !== "GET") return;
  const u = new URL(r.url);
  const own = u.origin === location.origin;
  const lib = /(^|\.)fonts\.(googleapis|gstatic)\.com$|^cdnjs\.cloudflare\.com$|\.tile\.openstreetmap\.org$|^tile\.openstreetmap\.org$|^upload\.wikimedia\.org$|^en\.wikipedia\.org$/.test(u.hostname);
  if (!own && !lib) return; // live data (accounts, crew feed, rates) always comes fresh from the network

  if (r.mode === "navigate") { // pages: newest when online, saved copy offline; any page falls back to the app
    e.respondWith(fetch(r).then(res => { if (res.ok) caches.open(CACHE).then(c => save(c, r, res)); return clean(res); })
      .catch(() => offlinePage(r)));
    return;
  }
  if (own) { // files: newest when online, saved copy offline
    e.respondWith(fetch(r).then(res => { if (res.ok) caches.open(CACHE).then(c => save(c, r, res)); return res; })
      .catch(() => caches.match(r, { ignoreSearch: true }).then(m => m || Response.error())));
    return;
  }
  // libraries, fonts, map tiles, postcard photos: saved copy first, network when missing
  e.respondWith(caches.match(r).then(m => m || fetch(r).then(res => { if (res.ok || res.type === "opaque") { const c = res.clone(); caches.open(CACHE).then(x => x.put(r, c)); } return res; })));
});
