// Step: handle the books that the "download books" step could not download
// directly, listed in result/not_downloaded_books.json.
//
// Each not-downloaded book carries one or more `links`, each tagged with a
// `domain`. This step dispatches every link to a per-domain handler that knows
// how to turn the landing page into one or more direct file downloads.
//
// Implemented domains:
//   taisachhay.net
//     1. The landing link carries the book id as a query param (`book_id`).
//     2. For every known format we build a direct-download URL of the shape
//          https://taisachhay.net/?taisachhay_download=<type>&book_id=<id>
//        and try each `type` in turn (azw3, epub, mobi, pdf, prc, zip, cbz).
//        Whatever responds with a real file is saved; formats that only return
//        an HTML page (i.e. the format is not available) are skipped.
//   drive.google.com
//     Uses a real (Chromium) browser, launched lazily only when a Drive link
//     is hit.
//       - Single file: downloaded named after the book, following Google's
//         "virus scan warning" confirm page when it appears.
//       - Folder: every file inside is enumerated recursively (descending into
//         subfolders) and the folder link is replaced in not_downloaded_books
//         by the individual /file/d/<id>/view child links. By default downloads
//         are PAUSED for folders — the children are only listed for review.
//         Pass --download-folders to actually download them (recreating the
//         folder structure under result/downloaded/<book>/, one file at a time).
//
// Outcome per book:
//   - If at least one file was downloaded (for any link / any format) the book
//     is recorded in result/downloaded_books.json (its files merged in).
//   - Links whose domain has no handler, or handled links that yielded no file,
//     are kept in result/not_downloaded_books.json. A book is removed from
//     not_downloaded_books.json only once every one of its links is resolved.
//
// Both JSON files are rewritten as work progresses so partial data survives
// interruptions.
//
// Optional CLI flags:
//   --max-books=N   only process the first N books (after --start offset)
//   --start=N       skip the first N books
//   --concurrency=N number of books processed in parallel (default 3)
//   --delay=N       wait N seconds between downloads on the same worker
//                   (default 0 = no delay)
//   --overwrite     re-download files that already exist on disk
//   --headed        run the Chromium browser with a visible window (drive.google.com)
//   --download-folders  actually download Drive folder contents (default: only
//                       list the child file links into not_downloaded for review)
//
// On an interactive terminal the script also prompts for concurrency and delay
// at startup (pressing Enter keeps the value shown in brackets), and shows a
// live per-worker progress line for each active download: bytes received, total
// size (when the server reports it), current speed, and a "stalled Ns" warning
// when no new bytes have arrived recently — so a dead/hung transfer is obvious.

const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const path = require('path');
const readline = require('readline');
const { chromium } = require('playwright');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const RESULT_DIR = path.join(PROJECT_ROOT, 'result');
const OUTPUT_DIR = path.join(RESULT_DIR, 'downloaded');
const DOWNLOADED_FILE = path.join(RESULT_DIR, 'downloaded_books.json');
const NOT_DOWNLOADED_FILE = path.join(RESULT_DIR, 'not_downloaded_books.json');

const REQUEST_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes per file

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Chromium streams in-progress downloads to a "<guid>.crdownload" file under
// its downloadsPath; we poll that file to show live download progress. The dir
// is created lazily (only the Drive handler needs the browser at all).
let DOWNLOADS_TMP = null;
function downloadsTmpDir() {
  if (!DOWNLOADS_TMP) {
    DOWNLOADS_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-dl-'));
  }
  return DOWNLOADS_TMP;
}
// Paths of *.crdownload files already attributed to a worker, so concurrent
// downloads each track their own file rather than fighting over one.
const claimedCrdownloads = new Set();
function claimCrdownload() {
  let entries;
  try {
    entries = fs.readdirSync(downloadsTmpDir());
  } catch (_err) {
    return null;
  }
  for (const name of entries) {
    if (!name.endsWith('.crdownload')) continue;
    const p = path.join(DOWNLOADS_TMP, name);
    if (claimedCrdownloads.has(p)) continue;
    claimedCrdownloads.add(p);
    return p;
  }
  return null;
}

// Formats to probe on taisachhay.net, in priority order.
const TAISACHHAY_TYPES = ['azw3', 'epub', 'mobi', 'pdf', 'prc', 'zip', 'cbz'];

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
const HEADED = Boolean(ARGS['headed']);

// When false (current default), a Drive folder is only expanded into its child
// file links, which are written back into not_downloaded_books.json for review —
// no files are downloaded. Pass --download-folders to actually download them.
const DOWNLOAD_FOLDER_FILES = Boolean(ARGS['download-folders']);

// How long to let a Drive page settle (SPA render) before scanning for buttons.
const PAGE_SETTLE_MS = 2500;
// How long to wait, in ms, for the actual file download to start after clicking
// a "download" button (which on Drive opens a virus-scan confirm popup first).
const DRIVE_DOWNLOAD_WAIT_MS = 25000;
// How long to wait for the confirm popup window to appear after a click.
const POPUP_WAIT_MS = 8000;
// Accepted (trimmed, lower-cased) labels for a download button. Google renders
// the Drive UI in the visitor's language (Vietnamese here), so we match both
// the English "download" and the Vietnamese "tải xuống".
const DOWNLOAD_LABELS = ['download', 'tải xuống'];

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
  resolved: 0, // books that gained at least one downloaded file this run
  files: 0, // individual book files saved this run
  bytes: 0,
  remaining: 0, // books still left in not_downloaded_books.json
  active: [], // { id, label }
};
let renderedLines = 0;

function fmtBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ---- Per-worker live download progress -----------------------------------
// A slot's `dl` holds the in-flight download so renderStatus can show how many
// bytes have arrived, the total (when known), the speed, and — crucially — how
// long it has been since the last byte, so a stalled/dead transfer is obvious.
function setSlotDownload(slot, label, total) {
  if (!slot) return;
  slot.dl = {
    label: label || slot.label,
    total: total || 0,
    bytes: 0,
    start: Date.now(),
    lastByteTime: Date.now(),
    samples: [],
    speed: 0,
  };
}
function setSlotBytes(slot, bytes) {
  if (!slot || !slot.dl) return;
  if (bytes > slot.dl.bytes) slot.dl.lastByteTime = Date.now();
  slot.dl.bytes = bytes;
}
function addSlotBytes(slot, n) {
  if (!slot || !slot.dl) return;
  slot.dl.bytes += n;
  slot.dl.lastByteTime = Date.now();
}
function clearSlotDownload(slot) {
  if (slot) slot.dl = null;
}

// Recompute each active download's speed from a short rolling window. Called by
// the once-a-second heartbeat so the rate keeps updating even between chunks.
function refreshSpeeds() {
  const now = Date.now();
  for (const slot of STATE.active) {
    const d = slot.dl;
    if (!d) continue;
    d.samples.push({ t: now, b: d.bytes });
    while (d.samples.length > 6) d.samples.shift();
    const first = d.samples[0];
    const span = now - first.t;
    d.speed = span >= 500 ? ((d.bytes - first.b) / span) * 1000 : d.speed;
  }
}

function renderStatus() {
  const lines = [
    `Books    : ${STATE.done}/${STATE.total}  ` +
      `(resolved: ${STATE.resolved}, remaining: ${STATE.remaining})`,
    `Files    : ${STATE.files}  (${fmtBytes(STATE.bytes)})`,
  ];
  if (STATE.active.length > 0) {
    for (const slot of STATE.active) {
      const d = slot.dl;
      if (d) {
        let p = fmtBytes(d.bytes);
        if (d.total) {
          p += ` / ${fmtBytes(d.total)} (${Math.floor(
            (d.bytes / d.total) * 100
          )}%)`;
        }
        p += ` @ ${fmtBytes(d.speed)}/s`;
        const idle = Date.now() - d.lastByteTime;
        if (idle > 4000) p += `  !! stalled ${Math.floor(idle / 1000)}s`;
        lines.push(`[t${slot.id}] ${d.label} — ${p}`);
      } else {
        lines.push(`[t${slot.id}] ${slot.label}`);
      }
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
    return new URL(link).hostname.replace(/^www\./, '');
  } catch (_err) {
    return null;
  }
}

// Issue a streaming GET and resolve with the live response stream *before* its
// body is consumed, so the caller can both inspect headers (to reject HTML
// landing pages) and report download progress chunk by chunk. Redirects are
// followed manually so the final stream still carries Content-Length.
function streamHttpGet(url, headers, redirectsLeft = 20) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (err) {
      reject(err);
      return;
    }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.get(u, { headers }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume(); // drain the redirect body
        if (redirectsLeft <= 0) {
          reject(new Error('too many redirects'));
          return;
        }
        const next = new URL(res.headers.location, u).toString();
        resolve(streamHttpGet(next, headers, redirectsLeft - 1));
        return;
      }
      resolve({ res, status, headers: res.headers });
    });
    req.on('error', reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () =>
      req.destroy(new Error('request timeout'))
    );
  });
}

// ---------------------------------------------------------------------------
// Generic single-URL downloader. Streams the body to <book name>.<ext> in
// OUTPUT_DIR, updating `slot` with live progress. Returns { file, bytes } on
// success or null when the URL is not a direct file download.
// ---------------------------------------------------------------------------
async function downloadToFile(book, url, ext, slot) {
  const dottedExt = ext ? (ext.startsWith('.') ? ext : `.${ext}`) : '';
  const baseName = sanitizeFilename(book.name) + dottedExt;

  let resp;
  try {
    resp = await streamHttpGet(url, {
      'User-Agent': USER_AGENT,
      Referer: 'https://taisachhay.net/',
      // Keep the body identity-encoded so streamed byte counts match the file.
      'Accept-Encoding': 'identity',
    });
  } catch (_err) {
    return null;
  }

  const { res, status, headers } = resp;
  const ct = (headers['content-type'] || '').toLowerCase();
  const isHtml = ct.includes('text/html') || ct.includes('application/xhtml');
  // A format taisachhay.net does not have answers with an HTML page; treat
  // anything non-200 or HTML as "not a real file" and discard it.
  if (status !== 200 || isHtml) {
    res.resume();
    return null;
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  let target = path.join(OUTPUT_DIR, baseName);
  if (fs.existsSync(target) && !OVERWRITE) {
    res.resume();
    return {
      file: path.basename(target),
      bytes: fs.statSync(target).size,
      skipped: true,
    };
  }
  if (OVERWRITE && fs.existsSync(target)) {
    fs.unlinkSync(target);
  } else if (!OVERWRITE) {
    target = path.join(OUTPUT_DIR, uniqueFilename(OUTPUT_DIR, baseName));
  }

  const total = parseInt(headers['content-length'] || '0', 10) || 0;
  setSlotDownload(slot, baseName, total);

  const out = fs.createWriteStream(target);
  try {
    await new Promise((resolve, reject) => {
      res.on('data', (chunk) => addSlotBytes(slot, chunk.length));
      res.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      res.pipe(out);
    });
  } catch (_err) {
    out.destroy();
    if (fs.existsSync(target)) {
      try {
        fs.unlinkSync(target);
      } catch (_unlinkErr) {
        // ignore partial-file cleanup failure
      }
    }
    clearSlotDownload(slot);
    return null;
  }
  clearSlotDownload(slot);

  const bytes = fs.existsSync(target) ? fs.statSync(target).size : 0;
  return { file: path.basename(target), bytes };
}

// Persist a Playwright `Download` into `dir`. When `baseName` is given the file
// is renamed to `<baseName><server-extension>` (used for single-file books);
// otherwise the server-suggested filename is kept (used for folder contents).
// The returned `file` is a path relative to OUTPUT_DIR so it stays meaningful
// for files saved inside a per-book subfolder.
async function persistDownload(download, dir, baseName, slot) {
  const suggested = download.suggestedFilename() || 'download';
  let fileName;
  if (baseName) {
    let ext = path.extname(suggested);
    if (ext.length > 6) ext = ''; // reject bogus "extensions" that are really text
    fileName = sanitizeFilename(baseName) + ext.toLowerCase();
  } else {
    fileName = sanitizeFilename(suggested);
  }

  fs.mkdirSync(dir, { recursive: true });

  let target = path.join(dir, fileName);
  if (fs.existsSync(target) && !OVERWRITE) {
    await download.cancel().catch(() => {});
    return {
      file: path.relative(OUTPUT_DIR, target),
      bytes: fs.statSync(target).size,
      skipped: true,
    };
  }
  if (OVERWRITE && fs.existsSync(target)) {
    fs.unlinkSync(target);
  } else if (!OVERWRITE && fs.existsSync(target)) {
    target = path.join(dir, uniqueFilename(dir, fileName));
  }

  // Playwright only exposes the file once the browser finishes downloading, so
  // for live progress we poll the matching <guid>.crdownload that Chromium is
  // actively writing under DOWNLOADS_TMP while saveAs() waits.
  setSlotDownload(slot, path.basename(target), 0);
  let stopWatch = false;
  const watcher = slot
    ? (async () => {
        let fp = null;
        for (let i = 0; i < 80 && !stopWatch && !fp; i += 1) {
          fp = claimCrdownload();
          if (!fp) await sleep(150);
        }
        while (!stopWatch) {
          if (fp) {
            try {
              setSlotBytes(slot, fs.statSync(fp).size);
            } catch (_statErr) {
              // file renamed/removed on completion — stop reading it
            }
          }
          await sleep(400);
        }
        if (fp) claimedCrdownloads.delete(fp);
      })()
    : null;

  try {
    await download.saveAs(target);
  } catch (err) {
    if (fs.existsSync(target)) {
      try {
        fs.unlinkSync(target);
      } catch (_unlinkErr) {
        // ignore partial file cleanup failures
      }
    }
    await download.cancel().catch(() => {});
    return null;
  } finally {
    stopWatch = true;
    if (watcher) await watcher.catch(() => {});
    clearSlotDownload(slot);
  }
  const bytes = fs.existsSync(target) ? fs.statSync(target).size : 0;
  return { file: path.relative(OUTPUT_DIR, target), bytes };
}

// ---------------------------------------------------------------------------
// Per-domain handlers. Each is called as handler(deps, book, linkEntry, slot)
// and returns { files, remaining } where:
//   files     downloaded file descriptors { link, domain, file, bytes } to add
//             to downloaded_books.json
//   remaining link entries that should stay in not_downloaded_books.json *in
//             place of* the input link (e.g. a folder expanded into the
//             individual file links that could not be downloaded). When nothing
//             was downloaded and nothing else is returned, the original link is
//             kept by the caller.
// `deps` exposes { getBrowser } so a handler can spin up a real browser when it
// needs one (taisachhay.net streams over plain HTTP without it). `slot` is the
// worker's live-status entry, updated with download progress.
// ---------------------------------------------------------------------------

// taisachhay.net: probe every known format via the download endpoint.
async function handleTaisachhay(deps, book, linkEntry, slot) {
  const sourceLink = linkEntry.link;
  let bookId = null;
  try {
    bookId = new URL(sourceLink).searchParams.get('book_id');
  } catch (_err) {
    bookId = null;
  }
  if (!bookId) return { files: [], remaining: [linkEntry] };

  const files = [];
  for (const type of TAISACHHAY_TYPES) {
    const dl = `https://taisachhay.net/?taisachhay_download=${encodeURIComponent(
      type
    )}&book_id=${encodeURIComponent(bookId)}`;

    const result = await downloadToFile(book, dl, type, slot);
    if (result) {
      files.push({
        link: dl,
        domain: 'taisachhay.net',
        file: result.file,
        bytes: result.bytes,
      });
      if (!result.skipped) {
        STATE.bytes += result.bytes || 0;
      }
      STATE.files += 1;
    }
    if (DELAY_MS > 0) await sleep(DELAY_MS);
  }
  return { files, remaining: [] };
}

// Click a candidate button and resolve with the resulting Playwright Download
// (or null). On Drive the "download" button opens a new tab pointing at
// drive.usercontent.google.com — usually a "Virus scan warning" page whose
// `#uc-download-link` ("Download anyway") submit triggers the real download.
// We listen for the download at the context level (it can fire on any tab) and,
// in the background, auto-confirm that warning popup if it shows up.
async function clickForDownload(context, locator) {
  let settled = false;
  const downloadPromise = context
    .waitForEvent('download', { timeout: DRIVE_DOWNLOAD_WAIT_MS })
    .then((d) => {
      settled = true;
      return d;
    })
    .catch(() => null);

  const popupHandler = (async () => {
    const popup = await context
      .waitForEvent('page', { timeout: POPUP_WAIT_MS })
      .catch(() => null);
    if (!popup || settled) return;
    try {
      await popup.waitForLoadState('domcontentloaded', { timeout: 10000 });
    } catch (_err) {
      // ignore — try clicking the confirm control anyway
    }
    // "Download anyway" on the virus-scan warning page.
    await popup
      .locator('#uc-download-link')
      .click({ timeout: 6000 })
      .catch(() => {});
  })();

  await locator.click({ timeout: 2000 }).catch(() => {});
  const download = await downloadPromise;
  await popupHandler.catch(() => {});
  return download;
}

// Extract the Drive file/folder id from any of the common Drive URL shapes
// (/file/d/<id>, /drive/folders/<id>, /folders/<id>, /d/<id>, ?id=<id>).
function extractDriveId(link) {
  try {
    const u = new URL(link);
    const byPath = u.pathname.match(
      /\/(?:file\/d|drive\/folders|folders|d)\/([^/]+)/
    );
    if (byPath) return byPath[1];
    const byQuery = u.searchParams.get('id');
    if (byQuery) return byQuery;
  } catch (_err) {
    // fall through
  }
  return null;
}

function isDriveFolderLink(link) {
  return /\/folders\//.test(link || '');
}

// Download a single Drive file (by id) via the drive.usercontent.google.com
// endpoint, which either streams the file directly or shows a "virus scan
// warning" page whose `#uc-download-link` ("Download anyway") submit starts the
// download. Saves into `dir`, keeping the server filename, or renamed to
// `baseName` when provided. Returns the saved descriptor or null.
async function downloadDriveFileById(context, fileId, dir, baseName, slot) {
  const page = await context.newPage();
  try {
    const downloadPromise = context.waitForEvent('download', {
      timeout: DRIVE_DOWNLOAD_WAIT_MS,
    });

    await page
      .goto(
        `https://drive.usercontent.google.com/download?id=${encodeURIComponent(
          fileId
        )}&export=download`,
        { waitUntil: 'domcontentloaded', timeout: 60000 }
      )
      .catch(() => {});

    // Small files may start downloading immediately; larger ones show a
    // "virus scan warning" page that needs #uc-download-link. Clicking that
    // button after a download already started cancels it ("saveAs: canceled").
    let download = await Promise.race([
      downloadPromise,
      page.waitForTimeout(1500).then(() => null),
    ]).catch(() => null);

    if (!download) {
      const confirm = page.locator('#uc-download-link');
      const needsConfirm = await confirm
        .isVisible({ timeout: 2000 })
        .catch(() => false);
      if (needsConfirm) {
        download = await clickForDownload(context, confirm);
      } else {
        download = await downloadPromise.catch(() => null);
      }
    }

    if (!download) return null;
    return await persistDownload(download, dir, baseName, slot);
  } finally {
    await page.close().catch(() => {});
  }
}

// Read the immediate children of a Drive folder. Returns [{ id, name, isFolder }].
// Scrolls to coax Drive into rendering long, lazily-loaded lists.
async function listDriveFolder(page, folderId) {
  await page
    .goto(
      `https://drive.google.com/drive/folders/${encodeURIComponent(folderId)}`,
      { waitUntil: 'domcontentloaded', timeout: 60000 }
    )
    .catch(() => {});
  await page.waitForTimeout(PAGE_SETTLE_MS);

  let prev = -1;
  for (let i = 0; i < 30; i += 1) {
    const count = await page
      .evaluate(() => document.querySelectorAll('[role="row"][data-id]').length)
      .catch(() => 0);
    if (count === prev) break;
    prev = count;
    await page
      .evaluate(() => {
        const rows = document.querySelectorAll('[role="row"][data-id]');
        const last = rows[rows.length - 1];
        if (last) last.scrollIntoView({ block: 'end' });
      })
      .catch(() => {});
    await page.waitForTimeout(600);
  }

  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[role="row"][data-id]'));
    const seen = new Set();
    const out = [];
    for (const r of rows) {
      const id = r.getAttribute('data-id');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const labeled = r.querySelector('[aria-label]');
      const aria =
        (labeled
          ? labeled.getAttribute('aria-label')
          : r.getAttribute('aria-label')) || '';
      const img = r.querySelector('img, svg');
      const imgAlt = img ? img.getAttribute('alt') || '' : '';
      const isFolder = /thư mục|\bfolder\b/i.test(aria) || /folder/i.test(imgAlt);
      // Strip the trailing "shared" / folder-type tokens Drive appends.
      const name = aria
        .replace(/\s+(Đã chia sẻ|Shared)\s*$/i, '')
        .replace(/\s+(Thư mục dùng chung|Thư mục|Shared folder|Folder)\s*$/i, '')
        .trim();
      out.push({ id, name, isFolder });
    }
    return out;
  });
}

// Recursively flatten a Drive folder into a list of files, preserving each
// file's relative folder path. Guards against cycles and runaway trees.
async function expandDriveFolder(page, rootId) {
  const MAX_FILES = 1000;
  const files = [];
  const seen = new Set();
  const stack = [{ id: rootId, rel: '' }];

  while (stack.length > 0 && files.length < MAX_FILES) {
    const { id, rel } = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);

    let items = [];
    try {
      items = await listDriveFolder(page, id);
    } catch (_err) {
      items = [];
    }

    for (const it of items) {
      if (it.isFolder) {
        const childRel = rel
          ? `${rel}/${sanitizeFilename(it.name)}`
          : sanitizeFilename(it.name);
        stack.push({ id: it.id, rel: childRel });
      } else {
        files.push({ id: it.id, name: it.name, rel });
      }
    }
  }
  return files;
}

// drive.google.com folder: enumerate every file inside (recursively), recreate
// the folder structure under result/downloaded/<book>/ and download each file
// one by one. The original folder link is effectively replaced by the
// individual file links; files that fail to download are kept in
// not_downloaded_books.json as those individual file links.
async function handleDriveFolder(deps, book, linkEntry, folderId, slot) {
  const browser = await deps.getBrowser();
  const context = await browser.newContext({
    acceptDownloads: true,
    userAgent: USER_AGENT,
  });
  const files = [];
  const remaining = [];

  try {
    const navPage = await context.newPage();
    let expanded = [];
    try {
      expanded = await expandDriveFolder(navPage, folderId);
    } finally {
      await navPage.close().catch(() => {});
    }

    if (expanded.length === 0) {
      // Could not read the folder — keep the original link to retry later.
      remaining.push(linkEntry);
      return { files, remaining };
    }

    const bookDir = sanitizeFilename(book.name);

    // Download paused: just list the child file links for review. The folder
    // link is replaced in not_downloaded_books.json by these individual links.
    if (!DOWNLOAD_FOLDER_FILES) {
      logAbove(`FOLDER [${book.name}]: listed ${expanded.length} child file(s)`);
      for (const f of expanded) {
        remaining.push({
          link: `https://drive.google.com/file/d/${f.id}/view`,
          domain: 'drive.google.com',
          name: f.name,
          path: f.rel || undefined,
          reason: 'expanded from folder (download paused)',
        });
      }
      return { files, remaining };
    }

    logAbove(`FOLDER [${book.name}]: downloading ${expanded.length} file(s)`);

    for (const f of expanded) {
      const fileLink = `https://drive.google.com/file/d/${f.id}/view`;
      const destDir = path.join(OUTPUT_DIR, bookDir, f.rel);
      const saved = await downloadDriveFileById(context, f.id, destDir, null, slot);
      if (saved) {
        files.push({
          link: fileLink,
          domain: 'drive.google.com',
          file: saved.file,
          bytes: saved.bytes,
        });
        if (!saved.skipped) STATE.bytes += saved.bytes || 0;
        STATE.files += 1;
      } else {
        remaining.push({
          link: fileLink,
          domain: 'drive.google.com',
          name: f.name,
          path: f.rel || undefined,
          reason: 'file download failed',
        });
      }
      if (DELAY_MS > 0) await sleep(DELAY_MS);
    }
  } finally {
    await context.close().catch(() => {});
  }

  return { files, remaining };
}

// drive.google.com single file: download it (named after the book). Uses the
// direct endpoint when the file id is known, otherwise opens the landing page
// and clicks the "download" button, following Google's virus-scan confirm popup.
async function handleDriveSingleFile(deps, book, linkEntry, fileId, slot) {
  const browser = await deps.getBrowser();
  const context = await browser.newContext({
    acceptDownloads: true,
    userAgent: USER_AGENT,
  });
  const files = [];

  const record = (saved) => {
    files.push({
      link: linkEntry.link,
      domain: 'drive.google.com',
      file: saved.file,
      bytes: saved.bytes,
    });
    if (!saved.skipped) STATE.bytes += saved.bytes || 0;
    STATE.files += 1;
  };

  try {
    if (fileId) {
      const saved = await downloadDriveFileById(
        context,
        fileId,
        OUTPUT_DIR,
        book.name,
        slot
      );
      if (saved) {
        record(saved);
        return { files, remaining: [] };
      }
    }

    // Fallback: open the landing page and click the "download" button(s),
    // mirroring the user-provided snippet (extended with the Vietnamese label).
    const page = await context.newPage();
    try {
      await page
        .goto(linkEntry.link, { waitUntil: 'domcontentloaded', timeout: 60000 })
        .catch(() => {});
      await page.waitForTimeout(PAGE_SETTLE_MS);

      const count = await page.evaluate((labels) => {
        const els = Array.from(document.querySelectorAll('div')).filter((el) =>
          labels.includes(el.textContent.trim().toLowerCase())
        );
        els.forEach((el, i) => el.setAttribute('data-dlbtn', String(i)));
        return els.length;
      }, DOWNLOAD_LABELS);

      for (let i = 0; i < count; i += 1) {
        const download = await clickForDownload(
          context,
          page.locator(`[data-dlbtn="${i}"]`)
        );
        if (download) {
          record(await persistDownload(download, OUTPUT_DIR, book.name, slot));
          break;
        }
      }
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    await context.close().catch(() => {});
  }

  return { files, remaining: files.length > 0 ? [] : [linkEntry] };
}

// drive.google.com dispatcher: folders are expanded and downloaded file by
// file; single files are downloaded directly.
async function handleDriveGoogle(deps, book, linkEntry, slot) {
  const link = linkEntry.link;
  const id = extractDriveId(link);
  if (isDriveFolderLink(link)) {
    if (!id) return { files: [], remaining: [linkEntry] };
    return handleDriveFolder(deps, book, linkEntry, id, slot);
  }
  return handleDriveSingleFile(deps, book, linkEntry, id, slot);
}

const HANDLERS = {
  'taisachhay.net': handleTaisachhay,
  'drive.google.com': handleDriveGoogle,
};

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

// Process one not-downloaded book: run every link through its domain handler.
// Returns:
//   { downloaded: <entry|null>, remainingLinks: <array> }
async function processBook(deps, book, slotId) {
  const slot = { id: slotId, label: book.name || book.url };
  STATE.active.push(slot);
  renderStatus();

  const baseInfo = {
    id: book.id,
    name: book.name,
    url: book.url,
    thumbnail: book.thumbnail,
    thumbnail_file: book.thumbnail_file || null,
  };
  const downloadedFiles = [];
  const remainingLinks = [];

  try {
    for (const linkEntry of book.links || []) {
      const domain = linkEntry.domain || domainOf(linkEntry.link);
      const handler = HANDLERS[domain];
      if (!handler) {
        // No handler for this domain yet — leave the link untouched.
        remainingLinks.push(linkEntry);
        continue;
      }

      const result = await handler(deps, book, linkEntry, slot);
      const files = (result && result.files) || [];
      const remaining = (result && result.remaining) || [];

      if (files.length > 0) {
        downloadedFiles.push(...files);
        logAbove(
          `OK   [${book.name}] ${domain}: ${files.length} file(s)`
        );
      }
      for (const r of remaining) remainingLinks.push(r);

      if (files.length === 0 && remaining.length === 0) {
        // Nothing downloaded and nothing returned — keep the original link.
        remainingLinks.push({
          ...linkEntry,
          reason: 'no direct-download format available',
        });
        logAbove(`SKIP [${book.name}] ${domain}: no downloadable format`);
      }
    }
  } finally {
    const idx = STATE.active.indexOf(slot);
    if (idx !== -1) STATE.active.splice(idx, 1);
  }

  return {
    downloaded:
      downloadedFiles.length > 0 ? { ...baseInfo, files: downloadedFiles } : null,
    remainingLinks,
  };
}

async function main() {
  if (!fs.existsSync(NOT_DOWNLOADED_FILE)) {
    throw new Error(
      `Missing ${NOT_DOWNLOADED_FILE}. Run the "download books" step first.`
    );
  }

  await promptConfig();
  console.log(
    `Concurrency: ${CONCURRENCY} | Delay: ${DELAY_MS / 1000}s | ` +
      `Output: ${OUTPUT_DIR}`
  );

  // not_downloaded is both the input and an output (entries are removed as they
  // get resolved). downloaded is append/merge only.
  const notDownloadedResults = loadJsonArray(NOT_DOWNLOADED_FILE);
  const downloadedResults = loadJsonArray(DOWNLOADED_FILE);
  const notDownloadedByUrl = new Map(
    notDownloadedResults.map((e, i) => [e.url, i])
  );
  const downloadedByUrl = new Map(downloadedResults.map((e, i) => [e.url, i]));

  // Build the queue: books that have at least one link we know how to handle,
  // limited by --start / --max-books.
  const handleable = notDownloadedResults.filter(
    (book) =>
      book &&
      book.url &&
      Array.isArray(book.links) &&
      book.links.some((l) => HANDLERS[l.domain || domainOf(l.link)])
  );
  const queue = handleable.slice(START_FROM, START_FROM + MAX_BOOKS);

  STATE.total = queue.length;
  STATE.remaining = notDownloadedResults.filter(Boolean).length;
  renderStatus();

  if (queue.length === 0) {
    logAbove('Nothing to do — no handleable books in not_downloaded_books.json.');
    return;
  }

  // Chromium is only needed by the browser-driven handlers (drive.google.com),
  // so launch it lazily and reuse the single instance across workers. A known
  // downloadsPath lets us watch the in-progress <guid>.crdownload file to report
  // live download progress.
  let browserPromise = null;
  const getBrowser = () => {
    if (!browserPromise) {
      browserPromise = chromium.launch({
        headless: !HEADED,
        downloadsPath: downloadsTmpDir(),
      });
    }
    return browserPromise;
  };

  const deps = { getBrowser };

  // Heartbeat: refresh download speeds and redraw the status block once a second
  // so the user can see progress (and spot a stalled transfer) between events.
  const heartbeat = IS_TTY
    ? setInterval(() => {
        refreshSpeeds();
        renderStatus();
      }, 1000)
    : null;
  if (heartbeat && heartbeat.unref) heartbeat.unref();

  let pendingWrite = false;
  const flush = () => {
    if (pendingWrite) return;
    pendingWrite = true;
    try {
      writeJson(DOWNLOADED_FILE, downloadedResults);
      writeJson(NOT_DOWNLOADED_FILE, notDownloadedResults.filter(Boolean));
    } finally {
      pendingWrite = false;
    }
  };

  // Merge a freshly-downloaded book into downloaded_books.json, appending any
  // file not already recorded for that book.
  const upsertDownloaded = (entry) => {
    if (downloadedByUrl.has(entry.url)) {
      const existing = downloadedResults[downloadedByUrl.get(entry.url)];
      const have = new Set((existing.files || []).map((f) => f.file));
      for (const f of entry.files) {
        if (!have.has(f.file)) existing.files.push(f);
      }
      existing.thumbnail_file = existing.thumbnail_file || entry.thumbnail_file;
    } else {
      downloadedByUrl.set(entry.url, downloadedResults.length);
      downloadedResults.push(entry);
    }
  };

  let cursor = 0;
  async function worker(slotId) {
    while (true) {
      const idx = cursor;
      if (idx >= queue.length) break;
      cursor += 1;

      const book = queue[idx];
      let outcome;
      try {
        outcome = await processBook(deps, book, slotId);
      } catch (err) {
        logAbove(
          `ERR  [${book.name || book.url}]: ${err.message || String(err)}`
        );
        outcome = {
          downloaded: null,
          remainingLinks: book.links || [],
        };
      }

      if (outcome.downloaded) {
        upsertDownloaded(outcome.downloaded);
        STATE.resolved += 1;
      }

      // Update / remove the book inside not_downloaded_books.json.
      const ndIdx = notDownloadedByUrl.get(book.url);
      if (ndIdx !== undefined) {
        if (outcome.remainingLinks.length === 0) {
          notDownloadedResults[ndIdx] = null; // fully resolved -> drop it
        } else {
          notDownloadedResults[ndIdx] = {
            ...notDownloadedResults[ndIdx],
            links: outcome.remainingLinks,
          };
        }
      }
      STATE.remaining = notDownloadedResults.filter(Boolean).length;

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
    if (heartbeat) clearInterval(heartbeat);
    writeJson(DOWNLOADED_FILE, downloadedResults);
    writeJson(NOT_DOWNLOADED_FILE, notDownloadedResults.filter(Boolean));
    if (browserPromise) {
      const browser = await browserPromise.catch(() => null);
      if (browser) await browser.close().catch(() => {});
    }
    if (DOWNLOADS_TMP) {
      try {
        fs.rmSync(DOWNLOADS_TMP, { recursive: true, force: true });
      } catch (_rmErr) {
        // ignore temp-dir cleanup failure
      }
    }
  }

  renderStatus();
  logAbove(
    `Done. Processed ${STATE.done} books ` +
      `(${STATE.files} files, ${fmtBytes(STATE.bytes)}) -> ${OUTPUT_DIR}`
  );
  logAbove(`Downloaded books: ${downloadedResults.length} -> ${DOWNLOADED_FILE}`);
  logAbove(
    `Still not downloaded: ${
      notDownloadedResults.filter(Boolean).length
    } -> ${NOT_DOWNLOADED_FILE}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
