// Step: download every book file listed in result/download_links.json.
//
// For each book we walk its `download_links` array and, per link:
//   1. Issue a GET via Playwright's APIRequestContext (follows redirects,
//      mirrors a real browser session).
//   2. Decide whether the response is a *direct* file download. A direct
//      download is an OK response whose body is a real file (i.e. the
//      Content-Type is not an HTML/landing page). Those are streamed to
//      <project-root>/result/downloaded/<file>.
//   3. Links that are NOT directly downloadable (HTML landing pages, errors,
//      viewer-only hosts like Google Drive folders, MEGA, MediaFire, ...) are
//      handed to handleByDomain(). For now that handler only records the link;
//      real per-domain logic will be added later.
//
// Output:
//   <project-root>/result/downloaded_books.json
//     Books that had at least one file downloaded directly, with the saved
//     file path(s).
//   <project-root>/result/not_downloaded_books.json
//     Books that had at least one link which could not be downloaded directly,
//     to be processed later by per-domain handlers.
//
// Both files are rewritten as work progresses so partial data survives
// interruptions. Files already present on disk are skipped, and --resume skips
// books already recorded in downloaded_books.json.
//
// Optional CLI flags:
//   --max-books=N   only process the first N books (after --start offset)
//   --start=N       skip the first N books
//   --no-resume     process every book, even ones already downloaded
//                   (resume is ON by default)
//   --concurrency=N number of parallel downloads (default 3)
//   --delay=N       wait N seconds between downloads on the same worker
//                   (default 0 = no delay)
//   --overwrite     re-download files that already exist on disk
//
// On an interactive terminal the script also prompts for resume, concurrency
// and delay at startup (pressing Enter keeps the value shown in brackets).

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { request } = require('playwright');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const INPUT_FILE = path.join(PROJECT_ROOT, 'result', 'download_links.json');
const RESULT_DIR = path.join(PROJECT_ROOT, 'result');
const OUTPUT_DIR = path.join(RESULT_DIR, 'downloaded');
const THUMB_DIR = path.join(OUTPUT_DIR, 'thumbnails');
const DOWNLOADED_FILE = path.join(RESULT_DIR, 'downloaded_books.json');
const NOT_DOWNLOADED_FILE = path.join(RESULT_DIR, 'not_downloaded_books.json');

const REQUEST_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes per file

// Parse simple `--key=value` flags + boolean `--flag` switches.
function parseArgs(argv) {
  const args = {};
  for (const raw of argv.slice(2)) {
    if (!raw.startsWith('--')) continue;
    const [key, value] = raw.slice(2).split('=');
    args[key] = value === undefined ? true : value;
  }
  return args;
}

const ARGS = parseArgs(process.argv);
const MAX_BOOKS = ARGS['max-books'] ? parseInt(ARGS['max-books'], 10) : Infinity;
const START_FROM = ARGS['start'] ? parseInt(ARGS['start'], 10) : 0;
const OVERWRITE = Boolean(ARGS['overwrite']);

// Resume defaults to ON: re-runs skip books already recorded as downloaded.
// Pass --no-resume to force reprocessing, or it can be toggled via the prompt.
let RESUME = ARGS['no-resume'] ? false : true;

// Concurrency + delay start from CLI flags (or defaults) and may be overridden
// by the interactive prompt at startup.
let CONCURRENCY = ARGS['concurrency']
  ? Math.max(1, parseInt(ARGS['concurrency'], 10))
  : 3;
// Delay between downloads on the same worker, in seconds. Default 0 = no delay.
let DELAY_MS = ARGS['delay'] ? Math.max(0, parseFloat(ARGS['delay'])) * 1000 : 0;

const sleep = (ms) =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

// Ask a single question on the terminal and resolve with the trimmed answer.
function ask(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(String(answer).trim());
    });
  });
}

// Interactively let the user choose concurrency + delay before the run.
// Skipped without a TTY so CI / piped runs keep using the CLI flags or defaults.
async function promptConfig() {
  if (!process.stdin.isTTY) return;

  const resumeInput = await ask(
    `Resume (bỏ qua sách đã tải)? [Y/n] [${RESUME ? 'Y' : 'n'}]: `
  );
  if (resumeInput) {
    const v = resumeInput.toLowerCase();
    if (v === 'n' || v === 'no' || v === 'false' || v === '0') RESUME = false;
    else if (v === 'y' || v === 'yes' || v === 'true' || v === '1') RESUME = true;
  }

  const concInput = await ask(
    `Số file tải song song (concurrency) [${CONCURRENCY}]: `
  );
  if (concInput) {
    const n = parseInt(concInput, 10);
    if (Number.isFinite(n) && n > 0) CONCURRENCY = n;
  }

  const delayInput = await ask(
    `Delay giữa các lần tải, tính bằng giây (delay) [${DELAY_MS / 1000}]: `
  );
  if (delayInput) {
    const d = parseFloat(delayInput);
    if (Number.isFinite(d) && d >= 0) DELAY_MS = d * 1000;
  }
}

// ---------------------------------------------------------------------------
// Live status block, redrawn in-place on TTYs.
// ---------------------------------------------------------------------------
const IS_TTY = Boolean(process.stdout.isTTY);
const STATE = {
  done: 0,
  total: 0,
  downloaded: 0, // books with >=1 direct download
  notDownloaded: 0, // books with >=1 link needing domain handling
  files: 0, // individual book files saved
  thumbs: 0, // thumbnails saved
  bytes: 0,
  active: [], // { id, label }
};
let renderedLines = 0;

function fmtBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function renderStatus() {
  const lines = [
    `Books    : ${STATE.done}/${STATE.total}  ` +
      `(downloaded: ${STATE.downloaded}, not-downloaded: ${STATE.notDownloaded})`,
    `Files    : ${STATE.files}  (thumbs: ${STATE.thumbs}, ${fmtBytes(STATE.bytes)})`,
  ];
  if (STATE.active.length > 0) {
    for (const slot of STATE.active) {
      lines.push(`[t${slot.id}] ${slot.label}`);
    }
  } else {
    lines.push('(idle)');
  }

  if (!IS_TTY) {
    console.log(lines.join(' || '));
    return;
  }

  if (renderedLines > 0) {
    process.stdout.write(`\x1b[${renderedLines}F`);
  }
  for (const line of lines) {
    process.stdout.write('\x1b[2K' + line + '\n');
  }
  for (let i = lines.length; i < renderedLines; i += 1) {
    process.stdout.write('\x1b[2K\n');
  }
  if (lines.length < renderedLines) {
    process.stdout.write(`\x1b[${renderedLines - lines.length}F`);
  }
  renderedLines = lines.length;
}

function logAbove(msg) {
  if (IS_TTY && renderedLines > 0) {
    process.stdout.write(`\x1b[${renderedLines}F`);
    for (let i = 0; i < renderedLines; i += 1) {
      process.stdout.write('\x1b[2K');
      if (i < renderedLines - 1) process.stdout.write('\n');
    }
    process.stdout.write(`\x1b[${renderedLines - 1}F`);
  }
  console.log(msg);
  renderedLines = 0;
}

// ---------------------------------------------------------------------------
// Filename helpers (Content-Disposition aware, filesystem-safe, unique).
// ---------------------------------------------------------------------------
function sanitizeFilename(name) {
  let cleaned = String(name || '')
    .replace(/[\\/\x00-\x1f]/g, '_')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  if (!cleaned) cleaned = 'file';
  if (cleaned.length > 200) cleaned = cleaned.slice(0, 200);
  return cleaned;
}

// Parse a `Content-Disposition` header value and return the filename if any.
// Handles both plain `filename="..."` and RFC 5987 `filename*=UTF-8''...`.
function filenameFromContentDisposition(header) {
  if (!header) return null;

  const star = header.match(/filename\*\s*=\s*([^;]+)/i);
  if (star) {
    const value = star[1].trim();
    const match = value.match(/^([^']*)'([^']*)'(.+)$/);
    if (match) {
      try {
        return decodeURIComponent(match[3].replace(/^"|"$/g, ''));
      } catch (_err) {
        // fall through to plain filename handling
      }
    }
  }

  const plain = header.match(/filename\s*=\s*("([^"]+)"|([^;]+))/i);
  if (plain) {
    const value = (plain[2] || plain[3] || '').trim();
    // HTTP headers are latin1, but servers (e.g. Google) often put raw UTF-8
    // bytes in the plain filename. Re-decode latin1 -> UTF-8 to undo the
    // mojibake; this is a no-op for pure ASCII names.
    const reDecoded = Buffer.from(value, 'latin1').toString('utf8');
    return reDecoded.includes('\uFFFD') ? value : reDecoded;
  }
  return null;
}

const EXT_FROM_TYPE = {
  'application/pdf': '.pdf',
  'application/epub+zip': '.epub',
  'application/x-mobipocket-ebook': '.mobi',
  'application/zip': '.zip',
  'application/x-rar-compressed': '.rar',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    '.docx',
  'text/plain': '.txt',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

// Extract a sane file extension from a name/path (rejects long "extensions"
// that are really part of the stem).
function extOf(name) {
  const ext = path.extname(String(name || ''));
  return ext && ext.length <= 6 ? ext.toLowerCase() : '';
}

// Decide a file extension, preferring (in order) the server-provided filename,
// the Content-Type, then the URL path.
function pickExtension(url, contentType, dispositionName) {
  let ext = extOf(dispositionName);
  if (!ext) {
    ext = EXT_FROM_TYPE[(contentType || '').split(';')[0].trim().toLowerCase()] || '';
  }
  if (!ext) {
    try {
      ext = extOf(new URL(url).pathname);
    } catch (_err) {
      // ignore — no extension is acceptable
    }
  }
  return ext;
}

// Guarantee a unique filename by appending " (n)" before the extension.
function uniqueFilename(dir, name) {
  let attempt = name;
  let counter = 1;
  while (fs.existsSync(path.join(dir, attempt))) {
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    attempt = `${stem} (${counter})${ext}`;
    counter += 1;
  }
  return attempt;
}

function domainOf(link) {
  try {
    return new URL(link).hostname;
  } catch (_err) {
    return null;
  }
}

// A response is a "direct" file download when it's OK and the body is not an
// HTML/landing page. Viewer pages (Google Drive folders, MEGA, MediaFire, ...)
// all answer with text/html and therefore fall through to the domain handler.
function isDirectDownload(response) {
  if (!response.ok()) return false;
  const ct = (response.headers()['content-type'] || '').toLowerCase();
  if (!ct) return true; // no type at all -> treat as a raw file
  return !(ct.includes('text/html') || ct.includes('application/xhtml'));
}

// Handle a link that could not be downloaded directly. For now this only
// classifies the link by domain and records it; per-domain download logic
// (Google Drive viewer, MediaFire, MEGA, ...) will be implemented later.
function handleByDomain(link, reason) {
  const domain = domainOf(link);
  // TODO: dispatch to per-domain handlers here based on `domain`.
  return { link, domain, reason, downloaded: false };
}

// ---------------------------------------------------------------------------
// Output (de)serialization. Results are kept in memory and rewritten wholesale.
// ---------------------------------------------------------------------------
function loadJsonArray(file) {
  if (!fs.existsSync(file)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (_err) {
    logAbove(`Warning: ${file} is not valid JSON, starting from scratch.`);
    return [];
  }
}

function writeJson(file, data) {
  fs.mkdirSync(RESULT_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// Download a single link. Returns one of:
//   { kind: 'file', link, domain, file, bytes }       direct download saved
//   { kind: 'domain', link, domain, reason }          handed to domain handler
async function downloadLink(reqCtx, book, link) {
  const domain = domainOf(link);
  let response;
  try {
    response = await reqCtx.get(link, {
      timeout: REQUEST_TIMEOUT_MS,
      maxRedirects: 20,
    });
  } catch (err) {
    const handled = handleByDomain(link, `request failed: ${err.message || err}`);
    return { kind: 'domain', ...handled };
  }

  if (!isDirectDownload(response)) {
    const reason = response.ok()
      ? `not a direct file (content-type: ${
          response.headers()['content-type'] || 'unknown'
        })`
      : `HTTP ${response.status()} ${response.statusText()}`;
    const handled = handleByDomain(link, reason);
    return { kind: 'domain', ...handled };
  }

  // Name the saved file after the book (from the JSON), keeping only a sensible
  // extension derived from the server response / URL.
  const headers = response.headers();
  const dispositionName = filenameFromContentDisposition(
    headers['content-disposition']
  );
  const ext = pickExtension(link, headers['content-type'], dispositionName);
  const baseName = sanitizeFilename(book.name) + ext;

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  let target = path.join(OUTPUT_DIR, baseName);
  if (fs.existsSync(target) && !OVERWRITE) {
    // Already on disk from a previous run.
    return {
      kind: 'file',
      link,
      domain,
      file: target,
      bytes: fs.statSync(target).size,
      skipped: true,
    };
  }
  if (OVERWRITE && fs.existsSync(target)) {
    fs.unlinkSync(target);
  } else if (!OVERWRITE) {
    const uniqueName = uniqueFilename(OUTPUT_DIR, baseName);
    target = path.join(OUTPUT_DIR, uniqueName);
  }

  const body = await response.body();
  fs.writeFileSync(target, body);
  return { kind: 'file', link, domain, file: target, bytes: body.length };
}

// Download the book's thumbnail into result/downloaded/thumbnails, named after
// the book (same as the file). Returns { file, bytes } or null when there is no
// thumbnail / the request fails (a missing thumbnail must not fail the book).
async function downloadThumbnail(reqCtx, book) {
  const url = book.thumbnail;
  if (!url || url === 'N/A') return null;

  let response;
  try {
    response = await reqCtx.get(url, {
      timeout: REQUEST_TIMEOUT_MS,
      maxRedirects: 20,
    });
  } catch (_err) {
    return null;
  }
  if (!response.ok()) return null;

  const ext =
    pickExtension(url, response.headers()['content-type'], null) || '.jpg';
  const baseName = sanitizeFilename(book.name) + ext;

  fs.mkdirSync(THUMB_DIR, { recursive: true });
  let target = path.join(THUMB_DIR, baseName);
  if (fs.existsSync(target) && !OVERWRITE) {
    return { file: path.basename(target), bytes: fs.statSync(target).size, skipped: true };
  }
  if (OVERWRITE && fs.existsSync(target)) {
    fs.unlinkSync(target);
  } else if (!OVERWRITE) {
    target = path.join(THUMB_DIR, uniqueFilename(THUMB_DIR, baseName));
  }

  const body = await response.body();
  fs.writeFileSync(target, body);
  return { file: path.basename(target), bytes: body.length };
}

async function processBook(reqCtx, book, slotId) {
  const slot = { id: slotId, label: book.name || book.url };
  STATE.active.push(slot);
  renderStatus();

  const baseInfo = {
    id: book.id,
    name: book.name,
    url: book.url,
    thumbnail: book.thumbnail,
    thumbnail_file: null,
  };
  const downloaded = []; // { link, domain, file, bytes }
  const notDownloaded = []; // { link, domain, reason }

  try {
    // Thumbnail first — independent of the book file outcome.
    const thumb = await downloadThumbnail(reqCtx, book);
    if (thumb) {
      baseInfo.thumbnail_file = thumb.file;
      if (!thumb.skipped) STATE.bytes += thumb.bytes || 0;
      STATE.thumbs += 1;
    }

    for (const link of book.download_links || []) {
      const res = await downloadLink(reqCtx, book, link);
      if (res.kind === 'file') {
        downloaded.push({
          link: res.link,
          domain: res.domain,
          file: path.basename(res.file),
          bytes: res.bytes,
        });
        if (!res.skipped) {
          STATE.bytes += res.bytes || 0;
        }
        STATE.files += 1;
      } else {
        notDownloaded.push({
          link: res.link,
          domain: res.domain,
          reason: res.reason,
        });
        logAbove(`SKIP [${res.link}]: ${res.reason}`);
      }
      if (DELAY_MS > 0) await sleep(DELAY_MS);
    }
  } finally {
    const idx = STATE.active.indexOf(slot);
    if (idx !== -1) STATE.active.splice(idx, 1);
  }

  return {
    ...baseInfo,
    downloaded: downloaded.length > 0 ? { ...baseInfo, files: downloaded } : null,
    notDownloaded:
      notDownloaded.length > 0 ? { ...baseInfo, links: notDownloaded } : null,
  };
}

async function main() {
  if (!fs.existsSync(INPUT_FILE)) {
    throw new Error(
      `Missing ${INPUT_FILE}. Run the "get download links" step first.`
    );
  }

  await promptConfig();
  console.log(
    `Resume: ${RESUME ? 'on' : 'off'} | Concurrency: ${CONCURRENCY} | ` +
      `Delay: ${DELAY_MS / 1000}s | Output: ${OUTPUT_DIR}`
  );

  const books = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));
  const sliced = books.slice(START_FROM, START_FROM + MAX_BOOKS);

  // Load existing outputs so we can merge / resume.
  const downloadedResults = loadJsonArray(DOWNLOADED_FILE);
  const notDownloadedResults = loadJsonArray(NOT_DOWNLOADED_FILE);
  const downloadedByUrl = new Map(downloadedResults.map((e, i) => [e.url, i]));
  const notDownloadedByUrl = new Map(
    notDownloadedResults.map((e, i) => [e.url, i])
  );

  // Build the queue: every book with at least one link, optionally skipping
  // those already recorded as downloaded when --resume is set.
  const queue = [];
  for (const book of sliced) {
    if (!book || !book.url) continue;
    if (!Array.isArray(book.download_links) || book.download_links.length === 0) {
      continue;
    }
    if (RESUME && downloadedByUrl.has(book.url)) continue;
    queue.push(book);
  }

  STATE.total = queue.length;
  STATE.downloaded = downloadedResults.length;
  STATE.notDownloaded = notDownloadedResults.length;

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  writeJson(DOWNLOADED_FILE, downloadedResults);
  writeJson(NOT_DOWNLOADED_FILE, notDownloadedResults);
  renderStatus();

  if (queue.length === 0) {
    logAbove('Nothing to do — no books to download.');
    return;
  }

  const reqCtx = await request.newContext({
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    extraHTTPHeaders: {
      Referer: 'https://sachmoi.net/',
    },
  });

  let pendingWrite = false;
  const flush = () => {
    if (pendingWrite) return;
    pendingWrite = true;
    try {
      writeJson(DOWNLOADED_FILE, downloadedResults);
      writeJson(NOT_DOWNLOADED_FILE, notDownloadedResults);
    } finally {
      pendingWrite = false;
    }
  };

  const upsert = (results, byUrl, entry) => {
    if (byUrl.has(entry.url)) {
      results[byUrl.get(entry.url)] = entry;
    } else {
      byUrl.set(entry.url, results.length);
      results.push(entry);
    }
  };

  let cursor = 0;
  async function worker(slotId) {
    while (true) {
      const idx = cursor;
      if (idx >= queue.length) break;
      cursor += 1;

      const book = queue[idx];
      const outcome = await processBook(reqCtx, book, slotId);

      if (outcome.downloaded) {
        upsert(downloadedResults, downloadedByUrl, outcome.downloaded);
        STATE.downloaded = downloadedResults.length;
      }
      if (outcome.notDownloaded) {
        upsert(notDownloadedResults, notDownloadedByUrl, outcome.notDownloaded);
        STATE.notDownloaded = notDownloadedResults.length;
      }

      STATE.done += 1;
      flush();
      renderStatus();
    }
  }

  try {
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, queue.length) }, (_, i) =>
        worker(i + 1)
      )
    );
  } finally {
    writeJson(DOWNLOADED_FILE, downloadedResults);
    writeJson(NOT_DOWNLOADED_FILE, notDownloadedResults);
    await reqCtx.dispose();
  }

  renderStatus();
  logAbove(
    `Done. Processed ${STATE.done} books ` +
      `(${STATE.files} files, ${fmtBytes(STATE.bytes)}) -> ${OUTPUT_DIR}`
  );
  logAbove(
    `Downloaded books: ${downloadedResults.length} -> ${DOWNLOADED_FILE}`
  );
  logAbove(
    `Not downloaded books: ${notDownloadedResults.length} -> ${NOT_DOWNLOADED_FILE}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
