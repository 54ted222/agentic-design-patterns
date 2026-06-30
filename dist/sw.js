// PWA service worker:外殼 cache-first、書籍內容 network-first(離線回退快取)。
const CACHE = 'adp-v3';
const SHELL = [
  './',
  'index.html',
  'app.js',
  'style.css',
  'books.json',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'vendor/marked.min.js',
  'vendor/highlight.min.js',
  'vendor/highlight-github.css',
];
self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => Promise.allSettled(SHELL.map((u) => c.add(u)))));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isContent = url.pathname.endsWith('.md') || url.pathname.endsWith('books.json');
  if (isContent) {
    e.respondWith(
      fetch(req)
        .then((r) => {
          const cp = r.clone();
          caches.open(CACHE).then((c) => c.put(req, cp));
          return r;
        })
        .catch(() => caches.match(req))
    );
  } else {
    e.respondWith(
      caches.match(req).then(
        (c) =>
          c ||
          fetch(req).then((r) => {
            const cp = r.clone();
            caches.open(CACHE).then((ca) => ca.put(req, cp));
            return r;
          })
      )
    );
  }
});
