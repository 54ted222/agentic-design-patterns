// 將閱讀器打包成可部署到 GitHub Pages 的靜態網站(輸出至 /dist)。
// 零外部相依：自行產生 books.json、PWA manifest/service worker、PNG 圖示，並複製書籍內容。
import { rm, mkdir, cp, writeFile, readdir, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');

const THEME = '#2563eb';

// ── 列出書籍變體(與 src/server.mjs 的 listBooks 邏輯一致) ──
async function listBooks() {
  const entries = await readdir(ROOT, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory() && /^book(-.+)?$/.test(e.name))
    .map((e) => e.name)
    .sort();
  const books = [];
  for (const name of dirs) {
    try {
      await access(join(ROOT, name, 'index.md'));
      const variant = name === 'book' ? '' : name.slice('book-'.length);
      books.push({ dir: name, variant, label: variant || '預設' });
    } catch {
      /* 沒有 index.md 就略過 */
    }
  }
  return books;
}

// ── 純 Node PNG 編碼(8-bit RGBA) ──
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

// 在圓角矩形內?
function inRoundRect(x, y, x0, y0, w, h, r) {
  const x1 = x0 + w, y1 = y0 + h;
  if (x < x0 || x >= x1 || y < y0 || y >= y1) return false;
  const cx = x < x0 + r ? x0 + r : x > x1 - r ? x1 - r : x;
  const cy = y < y0 + r ? y0 + r : y > y1 - r ? y1 - r : y;
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
// 產生圖示:藍底白色書頁卡片(置於遮罩安全區內,可同時作 any / maskable)。
function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const bg = [37, 99, 235];
  const card = [255, 255, 255];
  const line = [37, 99, 235];
  const cw = Math.round(size * 0.5);
  const ch = Math.round(size * 0.6);
  const cx0 = Math.round((size - cw) / 2);
  const cy0 = Math.round((size - ch) / 2);
  const r = Math.round(size * 0.06);
  const set = (x, y, c) => {
    const i = (y * size + x) * 4;
    rgba[i] = c[0];
    rgba[i + 1] = c[1];
    rgba[i + 2] = c[2];
    rgba[i + 3] = 255;
  };
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) set(x, y, inRoundRect(x, y, cx0, cy0, cw, ch, r) ? card : bg);
  // 卡片上的文字線條
  const lh = Math.max(2, Math.round(size * 0.03));
  const lx0 = cx0 + Math.round(cw * 0.16);
  const lx1 = cx0 + Math.round(cw * 0.84);
  for (const t of [0.28, 0.44, 0.6, 0.76]) {
    const ly = cy0 + Math.round(ch * t);
    for (let y = ly; y < ly + lh && y < size; y++) for (let x = lx0; x < lx1; x++) set(x, y, line);
  }
  return encodePng(size, rgba);
}

// ── 各產物模板 ──
const indexHtml = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <meta name="robots" content="noindex, nofollow, noarchive, nosnippet" />
  <meta name="googlebot" content="noindex, nofollow" />
  <title>代理設計模式 · 閱讀器</title>
  <link rel="manifest" href="manifest.webmanifest" />
  <link rel="icon" href="icon-192.png" />
  <link rel="apple-touch-icon" href="icon-192.png" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <meta name="apple-mobile-web-app-title" content="代理設計模式" />
  <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
  <meta name="theme-color" content="#0d1117" media="(prefers-color-scheme: dark)" />
  <link rel="stylesheet" href="style.css" />
  <link
    rel="stylesheet"
    href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/styles/github.min.css"
  />
  <style>
    #gate {
      position: fixed;
      inset: 0;
      z-index: 1000;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: var(--bg, #fff);
      color: var(--fg, #1f2328);
    }
    #gate form {
      width: 100%;
      max-width: 320px;
      text-align: center;
    }
    #gate h1 {
      font-size: 1.3rem;
      margin: 0 0 6px;
    }
    #gate p {
      margin: 0 0 20px;
      color: var(--muted, #656d76);
      font-size: 0.9rem;
    }
    #gate-pw {
      width: 100%;
      padding: 12px 14px;
      font-size: 1.1rem;
      text-align: center;
      letter-spacing: 0.3em;
      color: var(--fg, #1f2328);
      background: var(--sidebar-bg, #f6f8fa);
      border: 1px solid var(--border, #d8dee4);
      border-radius: 10px;
    }
    #gate button {
      width: 100%;
      margin-top: 12px;
      padding: 12px 14px;
      font-size: 1rem;
      color: #fff;
      background: ${THEME};
      border: 0;
      border-radius: 10px;
      cursor: pointer;
    }
    #gate-err {
      display: none;
      margin-top: 12px;
      color: #d1242f;
      font-size: 0.88rem;
    }
  </style>
</head>
<body>
  <div id="gate">
    <form id="gate-form">
      <h1>代理設計模式</h1>
      <p>請輸入密碼以閱讀</p>
      <input
        id="gate-pw"
        type="password"
        inputmode="numeric"
        autocomplete="off"
        autofocus
        aria-label="密碼"
      />
      <button type="submit">進入</button>
      <div id="gate-err">密碼錯誤,請再試一次</div>
    </form>
  </div>

  <button id="menu-toggle" aria-label="開啟目錄">☰</button>

  <aside id="sidebar">
    <div class="sidebar-head">
      <h1>代理設計模式</h1>
      <p class="subtitle">Agentic Design Patterns</p>
    </div>
    <nav id="toc"><p class="loading">載入目錄中…</p></nav>
  </aside>

  <div id="overlay"></div>

  <main id="content">
    <article id="chapter"><p class="loading">載入中…</p></article>
    <footer id="pager">
      <button id="prev" disabled>← 上一章</button>
      <button id="next" disabled>下一章 →</button>
    </footer>
  </main>

  <script src="https://cdn.jsdelivr.net/npm/marked@12/marked.min.js"></script>
  <script src="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/highlight.min.js"></script>
  <script>
    // 註冊 service worker(PWA 離線支援)
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
    }
    // 密碼閘門:正確前不載入閱讀器(亦不抓取任何書籍內容)。
    (function () {
      const PASSWORD = '1234';
      const gate = document.getElementById('gate');
      const form = document.getElementById('gate-form');
      const input = document.getElementById('gate-pw');
      const err = document.getElementById('gate-err');
      let started = false;
      function start() {
        if (started) return;
        started = true;
        gate.remove();
        import('./app.js');
      }
      if (sessionStorage.getItem('adp:auth') === '1') {
        start();
      } else {
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          if (input.value === PASSWORD) {
            sessionStorage.setItem('adp:auth', '1');
            start();
          } else {
            err.style.display = 'block';
            input.value = '';
            input.focus();
          }
        });
      }
    })();
  </script>
</body>
</html>
`;

const manifest = {
  name: '代理設計模式 · 閱讀器',
  short_name: '代理設計模式',
  description: 'Agentic Design Patterns 閱讀器',
  lang: 'zh-TW',
  start_url: '.',
  scope: '.',
  display: 'standalone',
  orientation: 'portrait',
  background_color: '#0d1117',
  theme_color: THEME,
  icons: [
    { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
};

const swJs = `// PWA service worker:外殼 cache-first、書籍內容 network-first(離線回退快取)。
const CACHE = 'adp-v1';
const SHELL = [
  './',
  'index.html',
  'app.js',
  'style.css',
  'books.json',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'https://cdn.jsdelivr.net/npm/marked@12/marked.min.js',
  'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/highlight.min.js',
  'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/styles/github.min.css',
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
`;

const robotsTxt = `User-agent: *\nDisallow: /\n`;

// ── 執行建置 ──
async function build() {
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  // 1. 外殼檔
  await cp(join(SRC, 'app.js'), join(DIST, 'app.js'));
  await cp(join(SRC, 'style.css'), join(DIST, 'style.css'));
  await writeFile(join(DIST, 'index.html'), indexHtml);
  await writeFile(join(DIST, 'manifest.webmanifest'), JSON.stringify(manifest, null, 2));
  await writeFile(join(DIST, 'sw.js'), swJs);
  await writeFile(join(DIST, 'robots.txt'), robotsTxt);
  await writeFile(join(DIST, '.nojekyll'), '');

  // 2. 圖示
  await writeFile(join(DIST, 'icon-192.png'), renderIcon(192));
  await writeFile(join(DIST, 'icon-512.png'), renderIcon(512));

  // 3. books.json(取代 /api/books)
  const books = await listBooks();
  await writeFile(join(DIST, 'books.json'), JSON.stringify(books));

  // 4. 複製書籍內容(含 assets)
  for (const b of books) {
    await cp(join(ROOT, b.dir), join(DIST, b.dir), { recursive: true });
  }

  console.log(`✅ 建置完成 → dist/  (書籍:${books.map((b) => b.dir).join(', ')})`);
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
