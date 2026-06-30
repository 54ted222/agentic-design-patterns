#!/usr/bin/env node
// 文字講稿 → 語音 (OpenAI TTS)
//
// 把 *.transcript.md 講稿轉成 *.transcript.mp3。
// OpenAI TTS 單次請求上限約 4096 字元,所以長講稿會依段落自動分批,
// 逐批生成 mp3 片段後,再合成成單一 mp3 檔。
//
// 用法:
//   OPENAI_API_KEY=sk-... node scripts/tts.mjs [檔案或資料夾...] [選項]
//
//   不給路徑時,預設處理 book/ 與 book-lite/ 底下所有 *.transcript.md。
//   給資料夾時,處理該資料夾(遞迴)底下所有 *.transcript.md。
//   給單一 .md 檔時,只處理該檔。
//
// 選項:
//   --voice <name>     朗讀聲音 (預設 alloy;可用 alloy/echo/fable/onyx/nova/shimmer/coral/ash/sage 等)
//   --model <name>     TTS 模型 (預設 gpt-4o-mini-tts;也可 tts-1 / tts-1-hd)
//   --limit <n>        每批最大字元數 (預設 1800)
//                      注意:gpt-4o-mini-tts 限制 2000 tokens,中文約 0.85 token/字,
//                      故預設 1800 字以保險;tts-1 / tts-1-hd 為 4096 字元上限,可調高。
//   --concurrency <n>  同檔內片段的併發請求數 (預設 4)
//   --force            mp3 已存在也重新生成 (預設跳過)
//   --dry-run          只印出分批計畫,不呼叫 API、不寫檔
//
// 範例:
//   node scripts/tts.mjs                                    # 全部講稿
//   node scripts/tts.mjs book                               # 只做 book/
//   node scripts/tts.mjs book/01-prompt-chaining.transcript.md
//   node scripts/tts.mjs --voice nova --model tts-1-hd book-lite

import { readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import OpenAI from 'openai'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// ---- 參數解析 -------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    voice: 'alloy',
    model: 'gpt-4o-mini-tts',
    limit: 1800,
    concurrency: 4,
    force: false,
    dryRun: false,
    paths: [],
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case '--voice': opts.voice = argv[++i]; break
      case '--model': opts.model = argv[++i]; break
      case '--limit': opts.limit = Number(argv[++i]); break
      case '--concurrency': opts.concurrency = Number(argv[++i]); break
      case '--force': opts.force = true; break
      case '--dry-run': opts.dryRun = true; break
      case '-h':
      case '--help': printHelp(); process.exit(0)
      default:
        if (a.startsWith('--')) { console.error(`未知選項: ${a}`); process.exit(1) }
        opts.paths.push(a)
    }
  }
  if (!(opts.limit > 0 && opts.limit < 4096)) {
    console.error('--limit 必須介於 1 ~ 4095'); process.exit(1)
  }
  return opts
}

function printHelp() {
  // 檔頭註解即說明,這裡印出精簡版
  console.log(`用法: node scripts/tts.mjs [檔案或資料夾...] [--voice n] [--model n] [--limit n] [--concurrency n] [--force] [--dry-run]
不給路徑時預設處理 book/ 與 book-lite/ 底下所有 *.transcript.md`)
}

// ---- 找出要處理的講稿檔 ---------------------------------------------------

const TRANSCRIPT_RE = /\.transcript\.md$/

async function walkTranscripts(dir, out) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'assets') continue
      await walkTranscripts(full, out)
    } else if (TRANSCRIPT_RE.test(e.name)) {
      out.push(full)
    }
  }
}

async function resolveTargets(paths) {
  const out = []
  const inputs = paths.length ? paths : ['book', 'book-lite']
  for (const p of inputs) {
    const full = p.startsWith('/') ? p : join(ROOT, p)
    let s
    try { s = await stat(full) } catch { console.error(`找不到: ${p}`); continue }
    if (s.isDirectory()) await walkTranscripts(full, out)
    else if (TRANSCRIPT_RE.test(full)) out.push(full)
    else console.error(`略過(非 .transcript.md): ${p}`)
  }
  // 去重 + 排序
  return [...new Set(out)].sort()
}

// ---- 講稿分批 -------------------------------------------------------------
//
// 以「空行分段」為基本切割單位累積,不超過 limit。
// 單一段落若本身超過 limit,再退而求其次依句末標點切細,
// 仍過長則硬切,確保每批都 ≤ limit。

const SENT_END = /(?<=[。!?！？\n])/

function splitParagraph(para, limit) {
  if (para.length <= limit) return [para]
  const pieces = []
  let buf = ''
  for (const sent of para.split(SENT_END)) {
    if (sent.length > limit) {
      // 連單句都太長:先把已累積的吐出,再硬切這句
      if (buf) { pieces.push(buf); buf = '' }
      for (let i = 0; i < sent.length; i += limit) pieces.push(sent.slice(i, i + limit))
      continue
    }
    if ((buf + sent).length > limit) { pieces.push(buf); buf = sent }
    else buf += sent
  }
  if (buf) pieces.push(buf)
  return pieces
}

function chunkText(text, limit) {
  const paras = text
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(Boolean)

  const chunks = []
  let buf = ''
  const flush = () => { if (buf.trim()) chunks.push(buf.trim()); buf = '' }

  for (const para of paras) {
    if (para.length > limit) {
      flush()
      for (const piece of splitParagraph(para, limit)) chunks.push(piece.trim())
      continue
    }
    // 段落間補回換行,讓朗讀有自然停頓
    const candidate = buf ? buf + '\n\n' + para : para
    if (candidate.length > limit) { flush(); buf = para }
    else buf = candidate
  }
  flush()
  return chunks
}

// ---- 併發控制 -------------------------------------------------------------

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  async function worker() {
    while (true) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i], i)
    }
  }
  const n = Math.min(limit, items.length)
  await Promise.all(Array.from({ length: n }, worker))
  return results
}

// ---- 單一講稿 → mp3 -------------------------------------------------------

async function synthFile(client, file, opts) {
  const rel = file.startsWith(ROOT) ? file.slice(ROOT.length + 1) : file
  const outPath = file.replace(TRANSCRIPT_RE, '.transcript.mp3')

  if (!opts.force && existsSync(outPath) && !opts.dryRun) {
    console.log(`⏭  跳過(已存在): ${basename(outPath)}  (--force 可覆蓋)`)
    return { file: rel, skipped: true }
  }

  const text = await readFile(file, 'utf8')
  const chunks = chunkText(text, opts.limit)
  const totalChars = chunks.reduce((s, c) => s + c.length, 0)

  console.log(`\n📄 ${rel}`)
  console.log(`   ${totalChars} 字 → ${chunks.length} 批 (上限 ${opts.limit}/批)`)
  chunks.forEach((c, i) => console.log(`     #${String(i + 1).padStart(2, '0')}  ${c.length} 字  ${JSON.stringify(c.slice(0, 24))}…`))

  if (opts.dryRun) return { file: rel, chunks: chunks.length, dryRun: true }

  const buffers = await mapWithConcurrency(chunks, opts.concurrency, async (chunk, i) => {
    const res = await client.audio.speech.create({
      model: opts.model,
      voice: opts.voice,
      input: chunk,
      response_format: 'mp3',
    })
    const buf = Buffer.from(await res.arrayBuffer())
    process.stdout.write(`     ✓ #${String(i + 1).padStart(2, '0')} (${(buf.length / 1024).toFixed(0)} KB)\n`)
    return buf
  })

  const merged = Buffer.concat(buffers)
  await writeFile(outPath, merged)
  console.log(`   💾 ${basename(outPath)}  (${(merged.length / 1024 / 1024).toFixed(2)} MB)`)
  return { file: rel, chunks: chunks.length, bytes: merged.length }
}

// ---- 主流程 ---------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const targets = await resolveTargets(opts.paths)

  if (!targets.length) { console.error('沒有找到任何 *.transcript.md'); process.exit(1) }

  console.log(`模型=${opts.model}  聲音=${opts.voice}  每批上限=${opts.limit} 字  共 ${targets.length} 個檔`)

  let client = null
  if (!opts.dryRun) {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) { console.error('\n❌ 未設定 OPENAI_API_KEY 環境變數'); process.exit(1) }
    client = new OpenAI({ apiKey })
  }

  const summary = []
  for (const file of targets) {
    try {
      summary.push(await synthFile(client, file, opts))
    } catch (err) {
      console.error(`   ❌ 失敗: ${err?.message || err}`)
      summary.push({ file, error: String(err?.message || err) })
    }
  }

  const ok = summary.filter(s => s.bytes).length
  const skip = summary.filter(s => s.skipped).length
  const fail = summary.filter(s => s.error).length
  console.log(`\n— 完成 —  生成 ${ok}  跳過 ${skip}  失敗 ${fail}`)
  if (fail) process.exit(1)
}

main().catch(err => { console.error(err); process.exit(1) })
