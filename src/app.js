// 簡易電子書閱讀器：解析 book/index.md 建立目錄，逐章載入 markdown 並渲染。

let bookDir = 'book'; // 目前書籍變體資料夾，可由選單切換
const bookBase = () => `/${bookDir}/`;

const tocEl = document.getElementById('toc');
const chapterEl = document.getElementById('chapter');
const prevBtn = document.getElementById('prev');
const nextBtn = document.getElementById('next');
const sidebar = document.getElementById('sidebar');
const overlay = document.getElementById('overlay');
const menuToggle = document.getElementById('menu-toggle');

let chapters = []; // [{ file, title }]

marked.setOptions({
  breaks: false,
  gfm: true,
  highlight(code, lang) {
    if (window.hljs && lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang }).value;
      } catch {
        /* 略過 */
      }
    }
    return code;
  },
});

async function fetchText(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`無法載入 ${path}（${res.status}）`);
  return res.text();
}

// 把 markdown 內的相對資源路徑（assets/...）改寫為以 /book/ 為基底。
function rewriteAssetPaths(container) {
  container.querySelectorAll('img[src], a[href]').forEach((el) => {
    const attr = el.tagName === 'IMG' ? 'src' : 'href';
    const val = el.getAttribute(attr);
    if (!val) return;
    if (/^(https?:|mailto:|#|\/)/i.test(val)) return; // 絕對路徑或錨點不動
    el.setAttribute(attr, bookBase() + val.replace(/^\.\//, ''));
  });
}

async function loadIndex() {
  chapters = [];
  const md = await fetchText(bookBase() + 'index.md');
  tocEl.innerHTML = marked.parse(md);
  rewriteAssetPaths(tocEl);

  // 收集章節順序，並攔截章節連結點擊。
  tocEl.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href') || '';
    const m = href.match(/([^/]+\.md)(?:#.*)?$/i);
    if (!m) return;
    const file = m[1];
    chapters.push({ file, title: a.textContent.trim(), el: a });
    a.dataset.file = file;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      navigate(file);
    });
  });
}

function setActive(file) {
  tocEl.querySelectorAll('a.active').forEach((a) => a.classList.remove('active'));
  const a = tocEl.querySelector(`a[data-file="${CSS.escape(file)}"]`);
  if (a) a.classList.add('active');
}

async function loadChapter(file) {
  chapterEl.innerHTML = '<p class="loading">載入中…</p>';
  try {
    const md = await fetchText(bookBase() + file);
    chapterEl.innerHTML = marked.parse(md);
    rewriteAssetPaths(chapterEl);
    if (window.hljs) chapterEl.querySelectorAll('pre code').forEach((b) => hljs.highlightElement(b));
  } catch (err) {
    chapterEl.innerHTML = `<p class="error">${err.message}</p>`;
  }
}

function updatePager(file) {
  const i = chapters.findIndex((c) => c.file === file);
  prevBtn.disabled = i <= 0;
  nextBtn.disabled = i < 0 || i >= chapters.length - 1;
  prevBtn.onclick = () => i > 0 && navigate(chapters[i - 1].file);
  nextBtn.onclick = () => i < chapters.length - 1 && navigate(chapters[i + 1].file);
}

async function navigate(file, { push = true } = {}) {
  setActive(file);
  updatePager(file);
  await loadChapter(file);
  localStorage.setItem(`adp:last:${bookDir}`, file);
  if (push) history.pushState({ file, book: bookDir }, '', `#${bookDir}/${file}`);
  document.getElementById('content').scrollTo(0, 0);
  window.scrollTo(0, 0);
  closeSidebar();
}

function openSidebar() {
  sidebar.classList.add('open');
  overlay.classList.add('show');
}
function closeSidebar() {
  sidebar.classList.remove('open');
  overlay.classList.remove('show');
}

menuToggle.addEventListener('click', openSidebar);
overlay.addEventListener('click', closeSidebar);

// 解析 hash：#book-variant/03-routing.md → { book, file }
function parseHash() {
  const raw = location.hash.slice(1);
  if (!raw) return {};
  const i = raw.lastIndexOf('/');
  if (i === -1) return { file: raw };
  return { book: raw.slice(0, i), file: raw.slice(i + 1) };
}

// 切換書籍變體：重載目錄並開啟起始章節。
async function switchBook(dir, { wantedFile = null, push = true } = {}) {
  bookDir = dir;
  const picker = document.getElementById('book-picker');
  if (picker) picker.value = dir;
  try {
    await loadIndex();
  } catch (err) {
    tocEl.innerHTML = `<p class="error">${err.message}</p>`;
    return;
  }
  const start =
    (wantedFile && chapters.some((c) => c.file === wantedFile) && wantedFile) ||
    localStorage.getItem(`adp:last:${dir}`) ||
    (chapters[0] && chapters[0].file);
  localStorage.setItem('adp:book', dir);
  if (start) navigate(start, { push });
  else chapterEl.innerHTML = '<p class="error">找不到任何章節。</p>';
}

function buildBookPicker(books) {
  if (books.length < 2) return; // 只有一本就不顯示選單
  const select = document.createElement('select');
  select.id = 'book-picker';
  for (const b of books) {
    const opt = document.createElement('option');
    opt.value = b.dir;
    opt.textContent = `版本：${b.label}`;
    select.appendChild(opt);
  }
  select.value = bookDir;
  select.addEventListener('change', () => switchBook(select.value));
  tocEl.parentNode.insertBefore(select, tocEl);
}

window.addEventListener('popstate', (e) => {
  const st = e.state || parseHash();
  if (!st.file) return;
  if (st.book && st.book !== bookDir) switchBook(st.book, { wantedFile: st.file, push: false });
  else navigate(st.file, { push: false });
});

(async function init() {
  let books;
  try {
    books = await fetch('/api/books').then((r) => r.json());
  } catch {
    books = [{ dir: 'book', variant: '', label: '預設' }];
  }
  if (!books.length) {
    tocEl.innerHTML = '<p class="error">找不到任何書籍。</p>';
    return;
  }

  const hash = parseHash();
  const dirs = books.map((b) => b.dir);
  const startDir =
    (hash.book && dirs.includes(hash.book) && hash.book) ||
    (localStorage.getItem('adp:book') && dirs.includes(localStorage.getItem('adp:book')) &&
      localStorage.getItem('adp:book')) ||
    books[0].dir;

  bookDir = startDir;
  buildBookPicker(books);
  await switchBook(startDir, { wantedFile: hash.file, push: false });
})();
