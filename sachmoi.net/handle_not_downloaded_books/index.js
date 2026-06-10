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
//     Opens the landing page in a real (Chromium) browser, finds every <div>
//     whose text is exactly "download", and clicks them one by one. After each
//     click it waits ~3s for a browser download to start; the first click that
//     produces a file wins (we save it and stop), otherwise it moves on to the
//     next button. Chromium is launched lazily, only when a Drive link is hit.
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
//
// On an interactive terminal the script also prompts for concurrency and delay
// at startup (pressing Enter keeps the value shown in brackets).

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { request, chromium } = require('playwright');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const RESULT_DIR = path.join(PROJECT_ROOT, 'result');
const OUTPUT_DIR = path.join(RESULT_DIR, 'downloaded');
const DOWNLOADED_FILE = path.join(RESULT_DIR, 'downloaded_books.json');
const NOT_DOWNLOADED_FILE = path.join(RESULT_DIR, 'not_downloaded_books.json');

const REQUEST_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes per file

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

function renderStatus() {
  const lines = [
    `Books    : ${STATE.done}/${STATE.total}  ` +
      `(resolved: ${STATE.resolved}, remaining: ${STATE.remaining})`,
    `Files    : ${STATE.files}  (${fmtBytes(STATE.bytes)})`,
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

// A response is a "direct" file download when it's OK and the body is not an
// HTML/landing page. A format that taisachhay.net does not provide answers with
// an HTML page (the homepage / an error), which we treat as "not available".
function isDirectDownload(response) {
  if (!response.ok()) return false;
  const ct = (response.headers()['content-type'] || '').toLowerCase();
  if (!ct) return true; // no type at all -> treat as a raw file
  return !(ct.includes('text/html') || ct.includes('application/xhtml'));
}

// ---------------------------------------------------------------------------
// Generic single-URL downloader. Saves the body under <book name>.<ext> in
// OUTPUT_DIR. Returns { file, bytes } on success or null when the URL is not a
// direct file download.
// ---------------------------------------------------------------------------
async function downloadToFile(reqCtx, book, url, ext) {
  let response;
  try {
    response = await reqCtx.get(url, {
      timeout: REQUEST_TIMEOUT_MS,
      maxRedirects: 20,
    });
  } catch (_err) {
    return null;
  }

  if (!isDirectDownload(response)) return null;

  const dottedExt = ext ? (ext.startsWith('.') ? ext : `.${ext}`) : '';
  const baseName = sanitizeFilename(book.name) + dottedExt;

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  let target = path.join(OUTPUT_DIR, baseName);
  if (fs.existsSync(target) && !OVERWRITE) {
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

  const body = await response.body();
  fs.writeFileSync(target, body);
  return { file: path.basename(target), bytes: body.length };
}

// Persist a Playwright `Download` to OUTPUT_DIR, named after the book and
// keeping the server-suggested extension. Returns { file, bytes, skipped? }.
async function saveDownload(book, download) {
  const suggested = download.suggestedFilename() || '';
  let ext = path.extname(suggested);
  if (ext.length > 6) ext = ''; // reject bogus "extensions" that are really text
  const baseName = sanitizeFilename(book.name) + ext.toLowerCase();

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  let target = path.join(OUTPUT_DIR, baseName);
  if (fs.existsSync(target) && !OVERWRITE) {
    await download.cancel().catch(() => {});
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

  await download.saveAs(target);
  const bytes = fs.existsSync(target) ? fs.statSync(target).size : 0;
  return { file: path.basename(target), bytes };
}

// ---------------------------------------------------------------------------
// Per-domain handlers. Each is called as handler(deps, book, linkEntry) and
// returns an array of downloaded file descriptors
//   { link, domain, file, bytes }
// (empty when nothing could be downloaded from the given link). `deps` exposes
// { reqCtx, getBrowser } so a handler can use the plain HTTP client or a real
// browser as needed.
// ---------------------------------------------------------------------------

// taisachhay.net: probe every known format via the download endpoint.
async function handleTaisachhay(deps, book, linkEntry) {
  const sourceLink = linkEntry.link;
  let bookId = null;
  try {
    bookId = new URL(sourceLink).searchParams.get('book_id');
  } catch (_err) {
    bookId = null;
  }
  if (!bookId) return [];

  const files = [];
  for (const type of TAISACHHAY_TYPES) {
    const dl = `https://taisachhay.net/?taisachhay_download=${encodeURIComponent(
      type
    )}&book_id=${encodeURIComponent(bookId)}`;

    const result = await downloadToFile(deps.reqCtx, book, dl, type);
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
  return files;
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

// drive.google.com: open the page in a browser and click every <div> whose
// text is a download label, waiting after each click for a download to start.
// The first click that yields a file wins.
async function handleDriveGoogle(deps, book, linkEntry) {
  const link = linkEntry.link;
  const browser = await deps.getBrowser();
  const context = await browser.newContext({
    acceptDownloads: true,
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  const files = [];

  try {
    try {
      await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (_err) {
      // Navigation timeouts are tolerated — the page may still be usable.
    }
    await page.waitForTimeout(PAGE_SETTLE_MS);

    // Tag every matching <div> so we can click them by a stable selector.
    // Mirrors the user-provided snippet (extended with the Vietnamese label):
    //   Array.from(document.querySelectorAll('div'))
    //     .filter(el => el.textContent.trim().toLowerCase() === 'download')
    const count = await page.evaluate((labels) => {
      const els = Array.from(document.querySelectorAll('div')).filter((el) =>
        labels.includes(el.textContent.trim().toLowerCase())
      );
      els.forEach((el, i) => el.setAttribute('data-dlbtn', String(i)));
      return els.length;
    }, DOWNLOAD_LABELS);

    for (let i = 0; i < count; i += 1) {
      const locator = page.locator(`[data-dlbtn="${i}"]`);
      const download = await clickForDownload(context, locator);
      if (download) {
        const saved = await saveDownload(book, download);
        files.push({
          link,
          domain: 'drive.google.com',
          file: saved.file,
          bytes: saved.bytes,
        });
        if (!saved.skipped) STATE.bytes += saved.bytes || 0;
        STATE.files += 1;
        break; // got the file — stop clicking further buttons
      }
    }
  } finally {
    await context.close().catch(() => {});
  }

  return files;
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

      const files = await handler(deps, book, linkEntry);
      if (files.length > 0) {
        downloadedFiles.push(...files);
        logAbove(
          `OK   [${book.name}] ${domain}: ${files
            .map((f) => f.file)
            .join(', ')}`
        );
      } else {
        // Handler ran but found nothing downloadable — keep the link around.
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

  const reqCtx = await request.newContext({
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    extraHTTPHeaders: {
      Referer: 'https://taisachhay.net/',
    },
  });

  // Chromium is only needed by the browser-driven handlers (drive.google.com),
  // so launch it lazily and reuse the single instance across workers.
  let browserPromise = null;
  const getBrowser = () => {
    if (!browserPromise) {
      browserPromise = chromium.launch({ headless: !HEADED });
    }
    return browserPromise;
  };

  const deps = { reqCtx, getBrowser };

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
      const outcome = await processBook(deps, book, slotId);

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
    writeJson(DOWNLOADED_FILE, downloadedResults);
    writeJson(NOT_DOWNLOADED_FILE, notDownloadedResults.filter(Boolean));
    await reqCtx.dispose();
    if (browserPromise) {
      const browser = await browserPromise.catch(() => null);
      if (browser) await browser.close().catch(() => {});
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
