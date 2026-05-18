// QR Visualizer service worker — cache-first for the versioned app shell.
const VERSION = 'qr-vis-v10';
const APP_SHELL = [
  './',
  './index.html',
  './learn.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/app.js',
  './js/decoder.js',
  './js/qr-anatomy.js',
  './js/explanations.js',
  './js/bitstream.js',
  './js/learn.js',
  './js/jsQR.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// Pre-resolve the cacheable URL set so the fetch handler can do a fast lookup.
function makeShellSet() {
  const base = self.registration.scope;
  const set = new Set();
  for (const p of APP_SHELL) {
    try { set.add(new URL(p, base).href); } catch {}
  }
  set.add(base); // root
  return set;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Restrict caching to the explicit app shell. Anything else (PWA install
  // probes, future analytics, etc.) goes straight to the network.
  const shell = makeShellSet();
  if (!shell.has(url.href)) return;

  // Cache-first — the shell is versioned via VERSION, so updates land
  // automatically when the SW version changes.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((resp) => {
        if (resp && resp.status === 200 && resp.type === 'basic') {
          const clone = resp.clone();
          caches.open(VERSION).then((c) => c.put(req, clone));
        }
        return resp;
      });
    })
  );
});
