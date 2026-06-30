// 簡易電子書閱讀器：解析 book/index.md 建立目錄，逐章載入 markdown 並渲染。

let bookDir = 'book'; // 目前書籍變體資料夾，可由選單切換
// 使用相對路徑，讓 dev server(根目錄)與 GitHub Pages(子路徑)皆可運作。
const bookBase = () => `${bookDir}/`;

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
});

// highlight.js 延後載入:只有當章節真的含程式碼區塊時才動態抓 CDN,
// 且不擋章節渲染——先把內文顯示出來,語法高亮在背景補上。
let hljsPromise = null;
function ensureHljs() {
  if (window.hljs) return Promise.resolve(window.hljs);
  if (!hljsPromise) {
    hljsPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      // 與 app.js 同目錄的 vendor/(本地檔):dev 為 /src/vendor、dist 為 ./vendor
      s.src = new URL('vendor/highlight.min.js', import.meta.url).href;
      s.onload = () => resolve(window.hljs);
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  return hljsPromise;
}

// 對容器內所有程式碼區塊上色(若需要才載入 hljs)
function highlightLater(container) {
  const blocks = container.querySelectorAll('pre code');
  if (!blocks.length) return;
  ensureHljs()
    .then((hljs) => blocks.forEach((b) => hljs.highlightElement(b)))
    .catch(() => {
      /* CDN 失敗就維持純文字,不影響閱讀 */
    });
}

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
    highlightLater(chapterEl); // 非阻塞:背景補上語法高亮
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
  setAudio(file);
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

// 清除所有快取 / 本機資料(PWA cache、Service Worker、localStorage、sessionStorage)後重新整理
const clearCacheBtn = document.getElementById('clear-cache');
if (clearCacheBtn) {
  clearCacheBtn.addEventListener('click', async () => {
    if (!confirm('清除所有快取與本機資料(含播放進度與設定)並重新整理?')) return;
    clearCacheBtn.disabled = true;
    clearCacheBtn.textContent = '清除中…';
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
      if (window.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
      localStorage.clear();
      sessionStorage.clear();
    } catch {
      /* 盡力而為,失敗也照樣重新整理 */
    }
    // 加上時間參數避免瀏覽器再吃舊的 HTML 快取
    location.replace(location.pathname + '?fresh=' + Date.now());
  });
}

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

/* ── 語音講稿播放器 ───────────────────────────────────────────────
   每一章 NN-topic.md 對應 NN-topic.transcript.mp3。切換章節時嘗試載入,
   檔案不存在就自動隱藏整個播放器。 */
const player = document.getElementById('player');
const audio = document.getElementById('audio');
const SKIP = 15; // 快進 / 倒退秒數

const $p = (id) => document.getElementById(id);
const playBtn = $p('p-play');
const seek = $p('p-seek');
const curEl = $p('p-cur');
const durEl = $p('p-dur');
const rateSel = $p('p-rate');
const muteBtn = $p('p-mute');
const volEl = $p('p-vol');
const transcriptBtn = $p('p-transcript');
const continueBtn = $p('p-continue');

// 自動續播:一章語音播完後,自動切到下一章並播放(預設開啟,可關閉並記住)
let autoNext = localStorage.getItem('adp:autonext') !== '0';
let autoPlayOnLoad = false; // 下一章 metadata 就緒後是否自動播放

function applyAutoNext(on) {
  autoNext = on;
  continueBtn.classList.toggle('on', on);
  continueBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  continueBtn.title = on ? '自動續播下一章(開)' : '自動續播下一章(關)';
  localStorage.setItem('adp:autonext', on ? '1' : '0');
}
continueBtn.addEventListener('click', () => applyAutoNext(!autoNext));
applyAutoNext(autoNext);

// 速度選單:x0.5 ~ x4,每級 0.25(用整數 *0.25 避免浮點誤差)
for (let i = 2; i <= 16; i++) {
  const r = i * 0.25;
  const opt = document.createElement('option');
  opt.value = String(r);
  opt.textContent = `${r}×`;
  if (r === 1) opt.selected = true;
  rateSel.appendChild(opt);
}

let curAudioFile = null; // 目前音檔對應的章節 file
let scrubbing = false; // 使用者正在拖曳進度條

const audioSrc = (file) => bookBase() + file.replace(/\.md$/i, '.transcript.mp3');
const posKey = () => `adp:pos:${bookDir}/${curAudioFile}`;

function fmtTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function paintSeek() {
  const pct = seek.max > 0 ? (seek.value / seek.max) * 100 : 0;
  seek.style.setProperty('--p', `${pct}%`);
}

// 切章:換音源,沒有音檔就隱藏播放器
function setAudio(file) {
  curAudioFile = file;
  audio.pause();
  player.classList.remove('playing');
  player.hidden = true; // 先藏,確認可播放再顯示
  seek.value = 0;
  paintSeek();
  curEl.textContent = '0:00';
  durEl.textContent = '0:00';
  audio.src = audioSrc(file);
  audio.load();
}

audio.addEventListener('loadedmetadata', () => {
  player.hidden = false;
  audio.defaultPlaybackRate = currentRate; // 新章節維持使用者選的速度
  audio.playbackRate = currentRate;
  durEl.textContent = fmtTime(audio.duration);
  seek.max = Math.max(1, Math.floor(audio.duration));
  // 還原上次播放位置
  const saved = parseFloat(localStorage.getItem(posKey()) || '0');
  if (saved > 0 && saved < audio.duration - 2) audio.currentTime = saved;
  // 由「自動續播」切過來的新章節:從頭播放
  if (autoPlayOnLoad) {
    autoPlayOnLoad = false;
    audio.currentTime = 0;
    audio.play().catch(() => {}); // 瀏覽器擋自動播放就靜默略過
  }
});

// 音檔不存在 / 載入失敗 → 隱藏播放器(不打擾閱讀)
audio.addEventListener('error', () => {
  autoPlayOnLoad = false; // 下一章沒有音檔就停止續播鏈
  player.hidden = true;
  player.classList.remove('playing');
});

audio.addEventListener('timeupdate', () => {
  if (!scrubbing) {
    seek.value = Math.floor(audio.currentTime);
    paintSeek();
  }
  curEl.textContent = fmtTime(audio.currentTime);
  if (curAudioFile) localStorage.setItem(posKey(), String(audio.currentTime));
});

audio.addEventListener('play', () => player.classList.add('playing'));
audio.addEventListener('pause', () => player.classList.remove('playing'));
audio.addEventListener('ended', () => {
  player.classList.remove('playing');
  if (curAudioFile) localStorage.removeItem(posKey());
  // 自動續播:切到下一章並自動播放
  if (autoNext) {
    const i = chapters.findIndex((c) => c.file === curAudioFile);
    const nextCh = i >= 0 ? chapters[i + 1] : null;
    if (nextCh) {
      autoPlayOnLoad = true; // 待新章 metadata 就緒後自動播放
      navigate(nextCh.file);
    }
  }
});

// ── 控制項 ──
playBtn.addEventListener('click', () => {
  if (audio.paused) audio.play();
  else audio.pause();
});
$p('p-back').addEventListener('click', () => {
  audio.currentTime = Math.max(0, audio.currentTime - SKIP);
});
$p('p-fwd').addEventListener('click', () => {
  audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + SKIP);
});

seek.addEventListener('input', () => {
  scrubbing = true;
  curEl.textContent = fmtTime(Number(seek.value));
  paintSeek();
});
seek.addEventListener('change', () => {
  audio.currentTime = Number(seek.value);
  scrubbing = false;
});

// 播放速度:下拉選單,記住設定
let currentRate = 1;
function applyRate(r) {
  if (!(r >= 0.5 && r <= 4)) r = 1; // 防呆:超出範圍或非數字回到 1
  r = Math.round(r / 0.25) * 0.25; // 對齊 0.25 級距,確保對得到選項
  currentRate = r;
  // 只調整速率,保留目前播放位置與播放狀態——避免某些瀏覽器在改速率時
  // 重載/跳位造成「重新播放」。
  const wasPlaying = !audio.paused;
  const t = audio.currentTime;
  audio.defaultPlaybackRate = r; // 切章/重載媒體後不會被重置回 1×
  audio.playbackRate = r;
  if (Number.isFinite(t) && Math.abs(audio.currentTime - t) > 0.05) audio.currentTime = t;
  if (wasPlaying && audio.paused) audio.play().catch(() => {});
  rateSel.value = String(r);
  localStorage.setItem('adp:rate', String(r));
}
rateSel.addEventListener('change', () => applyRate(Number(rateSel.value)));

// 音量 / 靜音,記住設定
function applyVolume(v, muted) {
  audio.volume = v;
  audio.muted = muted;
  volEl.value = v;
  muteBtn.classList.toggle('muted', muted || v === 0);
  localStorage.setItem('adp:vol', String(v));
  localStorage.setItem('adp:muted', muted ? '1' : '0');
}
volEl.addEventListener('input', () => applyVolume(Number(volEl.value), false));
muteBtn.addEventListener('click', () => applyVolume(audio.volume, !audio.muted));

// 鍵盤:空白鍵播放/暫停、左右方向鍵快轉(不干擾輸入框與內文捲動)
document.addEventListener('keydown', (e) => {
  if (player.hidden) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  if (e.code === 'Space') {
    e.preventDefault();
    audio.paused ? audio.play() : audio.pause();
  } else if (e.code === 'ArrowLeft' && e.altKey) {
    audio.currentTime = Math.max(0, audio.currentTime - SKIP);
  } else if (e.code === 'ArrowRight' && e.altKey) {
    audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + SKIP);
  }
});

// ── 文字稿彈框 ──
const transcriptModal = document.getElementById('transcript-modal');
const transcriptBody = document.getElementById('transcript-body');
const transcriptTitle = document.getElementById('transcript-title');
const transcriptCache = new Map(); // file → 段落 HTML,避免重複下載

const escapeHtml = (s) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function openTranscript() {
  if (!curAudioFile) return;
  const ch = chapters.find((c) => c.file === curAudioFile);
  transcriptTitle.textContent = ch ? `文字稿 · ${ch.title}` : '文字稿';
  transcriptModal.showModal();

  if (transcriptCache.has(curAudioFile)) {
    transcriptBody.innerHTML = transcriptCache.get(curAudioFile);
    transcriptBody.scrollTop = 0;
    return;
  }
  transcriptBody.innerHTML = '<p class="loading">載入文字稿中…</p>';
  try {
    const path = bookBase() + curAudioFile.replace(/\.md$/i, '.transcript.md');
    const text = await fetchText(path);
    // 純文字講稿:以空行分段,逐段轉成 <p>
    const html = text
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
      .join('');
    transcriptCache.set(curAudioFile, html);
    transcriptBody.innerHTML = html;
    transcriptBody.scrollTop = 0;
  } catch (err) {
    transcriptBody.innerHTML = `<p class="error">${err.message}</p>`;
  }
}

transcriptBtn.addEventListener('click', openTranscript);
document.getElementById('transcript-close').addEventListener('click', () => transcriptModal.close());
// 點背景(dialog 本體外的區域)關閉
transcriptModal.addEventListener('click', (e) => {
  if (e.target === transcriptModal) transcriptModal.close();
});

// 還原偏好設定
applyRate(parseFloat(localStorage.getItem('adp:rate')) || 1);
applyVolume(
  localStorage.getItem('adp:vol') != null ? parseFloat(localStorage.getItem('adp:vol')) : 1,
  localStorage.getItem('adp:muted') === '1'
);

(async function init() {
  // 靜態部署(GitHub Pages)讀 books.json；本地 dev server 走 /api/books；皆失敗則用預設。
  let books;
  try {
    books = await fetch('books.json').then((r) => (r.ok ? r.json() : Promise.reject()));
  } catch {
    try {
      books = await fetch('/api/books').then((r) => r.json());
    } catch {
      books = [{ dir: 'book', variant: '', label: '預設' }];
    }
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
