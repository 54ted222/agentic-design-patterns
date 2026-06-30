// 零依賴靜態伺服器：服務專案根目錄，讓閱讀器(/src)與書籍(/book)可一起存取。
import { createServer } from 'node:http';
import { readFile, readdir, access } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PORT = process.env.PORT || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

// 列出所有書籍變體：根目錄下名為 book 或 book-* 且含 index.md 的資料夾。
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

const server = createServer(async (req, res) => {
  try {
    let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);

    if (pathname === '/api/books') {
      const books = await listBooks();
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      res.end(JSON.stringify(books));
      return;
    }

    if (pathname === '/') pathname = '/src/index.html';

    // 防止路徑穿越
    const filePath = normalize(join(ROOT, pathname));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    const data = await readFile(filePath);
    const type = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
    } else {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('500 Internal Server Error');
    }
  }
});

server.listen(PORT, () => {
  console.log(`📖 閱讀器已啟動： http://localhost:${PORT}`);
});
