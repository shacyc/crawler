// Step: get download links for every book in result/book_links.json.
//
// For each book we:
//   1. Build the download page URL by replacing the "https://sachmoi.net/"
//      prefix of the book url with "https://sachmoi.net/download/".
//   2. Open that download page.
//   3. Collect every <a> whose text is exactly "Download" and whose href
//      points at docs.google.com/uc?id= — these are the actual file links.
//
// Output:
//   <project-root>/result/download_links.json
//     Flat list of books (id, name, url, thumbnail) each enriched with a
//     `download_url` (the /download/ page) and `download_links` array.
//   <project-root>/result/download_links_failed.json
//     Subset of books that errored out OR returned no download links, so they
//     can be reviewed / retried separately.
//
// The output file is rewritten as work progresses so partial data survives
// interruptions. Re-running with --resume skips books that already have a
// successful entry.
//
// Optional CLI flags:
//   --mode=retry    only re-process books that previously failed
//                   (alias: --retry). Default mode processes the whole list.
//   --max-books=N   only process the first N books (after --start offset)
//   --start=N       skip the first N books (resume support)
//   --resume        skip books that already exist in the output
//   --concurrency=N open N parallel pages (default 3)
//   --delay=N       wait N seconds between pages (default 0 = no delay)
//   --headed        run with a visible browser window
//
// On an interactive terminal the script also prompts for the mode, concurrency
// and delay at startup (pressing Enter keeps the value shown in brackets).

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { chromium } = require('playwright');

const SITE_PREFIX = 'https://sachmoi.net/';
const DOWNLOAD_PREFIX = 'https://sachmoi.net/download/';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const INPUT_FILE = path.join(PROJECT_ROOT, 'result', 'book_links.json');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'result');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'download_links.json');
const OUTPUT_FAILED_FILE = path.join(OUTPUT_DIR, 'download_links_failed.json');

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
// Concurrency + delay start from CLI flags (or defaults) and may be overridden
// by the interactive prompt at startup. They are `let` so promptConfig() can
// update them before the run begins.
let CONCURRENCY = ARGS['concurrency']
  ? Math.max(1, parseInt(ARGS['concurrency'], 10))
  : 3;
// Delay between pages, in seconds. Default 0 = no delay.
let DELAY_MS = ARGS['delay']
  ? Math.max(0, parseFloat(ARGS['delay'])) * 1000
  : 0;
const HEADLESS = !ARGS['headed'];
const RESUME = Boolean(ARGS['resume']);

// Run mode:
//   'default' -> process the book list normally
//   'retry'   -> only re-process books that previously failed
// May be overridden by the interactive prompt at startup.
let MODE =
  ARGS['mode'] === 'retry' || ARGS['retry'] ? 'retry' : 'default';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Ask a single question on the terminal and resolve with the trimmed answer.
function ask(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// Interactively let the user choose concurrency + delay before the run.
// Skipped in non-interactive environments (no TTY) so CI / piped runs keep
// using the CLI flags or defaults. Pressing Enter keeps the current value.
async function promptConfig() {
  if (!process.stdin.isTTY) return;

  const modeInput = await ask(
    `Chọn mode: [1] default - chạy bình thường, [2] retry - chạy lại link fail [${
      MODE === 'retry' ? '2' : '1'
    }]: `
  );
  if (modeInput === '2' || modeInput.toLowerCase() === 'retry') {
    MODE = 'retry';
  } else if (modeInput === '1' || modeInput.toLowerCase() === 'default') {
    MODE = 'default';
  }

  const concInput = await ask(
    `Số trang chạy song song (concurrency) [${CONCURRENCY}]: `
  );
  if (concInput) {
    const n = parseInt(concInput, 10);
    if (Number.isFinite(n) && n > 0) CONCURRENCY = n;
  }

  const delayInput = await ask(
    `Delay giữa các trang, tính bằng giây (delay) [${DELAY_MS / 1000}]: `
  );
  if (delayInput) {
    const d = parseFloat(delayInput);
    if (Number.isFinite(d) && d >= 0) DELAY_MS = d * 1000;
  }
}

// Detect errors that mean the browser/context/page itself is gone (crash,
// disconnect, or manual interruption) rather than a problem with one URL.
// When this happens there is no point recording per-book failures — every
// remaining navigation will throw the same thing.
function isBrowserClosedError(message) {
  if (!message) return false;
  return (
    message.includes('Target page, context or browser has been closed') ||
    message.includes('Target closed') ||
    message.includes('Browser has been closed') ||
    message.includes('browser has disconnected') ||
    message.includes('has been closed')
  );
}

const IS_TTY = Boolean(process.stdout.isTTY);
const STATUS_LINES = 4;
let statusRendered = false;

const STATE = {
  done: 0,
  total: 0,
  failed: 0,
  withLinks: 0,
  current: '-',
};

// Render the live status block, redrawing in-place on TTYs.
function renderStatus() {
  const lines = [
    `Books    : ${STATE.done}/${STATE.total}  (failed: ${STATE.failed})`,
    `WithLink : ${STATE.withLinks}`,
    `Output   : ${OUTPUT_FILE}`,
    `Current  : ${STATE.current}`,
  ];

  if (!IS_TTY) {
    console.log(lines.join(' || '));
    return;
  }

  if (statusRendered) {
    process.stdout.write(`\x1b[${STATUS_LINES}F`); // move cursor up
  }
  for (const line of lines) {
    process.stdout.write('\x1b[2K'); // clear entire line
    process.stdout.write(line + '\n');
  }
  statusRendered = true;
}

// Print a permanent message above the live status block (errors / milestones).
function logAbove(msg) {
  if (IS_TTY && statusRendered) {
    process.stdout.write(`\x1b[${STATUS_LINES}F`);
    for (let i = 0; i < STATUS_LINES; i += 1) {
      process.stdout.write('\x1b[2K');
      if (i < STATUS_LINES - 1) process.stdout.write('\n');
    }
    process.stdout.write(`\x1b[${STATUS_LINES - 1}F`);
  }
  console.log(msg);
  statusRendered = false;
}

// Turn a book url into its /download/ page url.
function toDownloadUrl(url) {
  if (typeof url !== 'string') return null;
  if (url.startsWith(DOWNLOAD_PREFIX)) return url; // already transformed
  if (url.startsWith(SITE_PREFIX)) {
    return DOWNLOAD_PREFIX + url.slice(SITE_PREFIX.length);
  }
  return null;
}

// Collect every Google Docs download link on the current page.
async function extractDownloads(page) {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll('a'))
      .filter(
        (a) =>
          a.textContent.trim() === 'Download' &&
          (
            a.href.includes('docs.google.com/')
            || a.href.includes('taisachhay.net/?tai_sach=1')
            || a.href.includes('drive.usercontent.google.com/')
            || a.href.includes('media.metaisach.com/')
            || a.href.includes('static-xuatban.ebook365.vn/')
            || a.href.includes('media.metaisach.com/')
            || a.href.includes('drive.google.com')
            || a.href.includes('archive.org')
            || a.href.includes('mediafire.com')
            || a.href.includes('mega.nz')
            || a.href.includes('app.box.com')
            || a.href.includes('dropbox.com')
            || a.href.includes('onedrive.live.com')
            || a.href.includes('terabox.com')
            || a.href.includes('online.fliphtml5.com')
            || a.href.includes('github.com')
            || a.href.includes('drive.proton.me')
            || a.href.includes('fshare.vn')
            || a.href.includes('4shared.com')
            || a.href.includes('1drv.ms')
            || a.href.includes('up.nhuttruong.com')
            || a.href.includes('compress-pdf.vietdreamhouse.com')
            || a.href.includes('scribsave.net')
            || a.href.includes('thehehochiminh.files.wordpress.com')
          )
      )
      .map((a) => a.href);
  });
}

// Detect the site's "page not found" screen. Used to flag a book as 404 when
// no download link could be extracted.
async function isNotFoundPage(page) {
  return page.evaluate(() => {
    return Boolean(
      Array.from(document.querySelectorAll('h1.page-title')).find(
        (el) => el.textContent.trim() === 'Rất tiếc, trang không tồn tại :('
      )
    );
  });
}

function loadExistingResults() {
  if (!fs.existsSync(OUTPUT_FILE)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (err) {
    logAbove(`Warning: ${OUTPUT_FILE} is not valid JSON, starting from scratch.`);
    return [];
  }
}

// A book "failed" if it errored out or returned no download links.
function isFailed(entry) {
  return Boolean(
    entry &&
    (entry.error ||
      !Array.isArray(entry.download_links) ||
      entry.download_links.length === 0)
  );
}

function writeResults(results) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2), 'utf8');
  const failed = results.filter(isFailed);
  fs.writeFileSync(OUTPUT_FAILED_FILE, JSON.stringify(failed, null, 2), 'utf8');
}

async function processBook(page, book) {
  const entry = {
    id: book.id,
    name: book.name,
    url: book.url,
    thumbnail: book.thumbnail,
    download_url: toDownloadUrl(book.url),
    download_links: [],
    error: null,
  };

  if (!entry.download_url) {
    entry.error = `cannot build download url from: ${book.url}`;
    return entry;
  }

  try {
    await page.goto(entry.download_url, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });
  } catch (err) {
    entry.error = `goto failed: ${err.message}`;
    return entry;
  }

  try {
    const links = await extractDownloads(page);
    entry.download_links = Array.from(new Set(links));

    // No link found: distinguish a missing page (404) from a page that simply
    // has no download link.
    if (entry.download_links.length === 0 && (await isNotFoundPage(page))) {
      entry.error = '404';
    }
  } catch (err) {
    entry.error = `extract failed: ${err.message}`;
  }

  return entry;
}

async function main() {
  if (!fs.existsSync(INPUT_FILE)) {
    throw new Error(`Missing ${INPUT_FILE}. Run the "get books link" step first.`);
  }

  await promptConfig();
  console.log(
    `Mode: ${MODE} | Concurrency: ${CONCURRENCY} | Delay: ${DELAY_MS / 1000}s`
  );

  const books = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));
  const sliced = books.slice(START_FROM, START_FROM + MAX_BOOKS);

  // Load existing results so we can resume / merge.
  const existing = loadExistingResults();
  const existingByUrl = new Map(existing.map((e) => [e.url, e]));

  // Build the queue depending on the run mode.
  let queue = [];
  if (MODE === 'retry') {
    // Retry mode: only re-process books that previously failed (errored out
    // or returned no download links). Falls back to nothing if there is no
    // prior output yet.
    queue = existing.filter(isFailed).slice(0, MAX_BOOKS);
  } else {
    // Default mode: process the whole list. With --resume, skip URLs already
    // completed successfully.
    for (const book of sliced) {
      if (!book || !book.url) continue;
      if (RESUME && existingByUrl.has(book.url)) {
        const prev = existingByUrl.get(book.url);
        if (!prev.error) continue; // already done successfully, skip
      }
      queue.push(book);
    }
  }

  STATE.total = queue.length;
  STATE.done = 0;
  STATE.failed = 0;
  STATE.withLinks = existing.filter(
    (e) => Array.isArray(e.download_links) && e.download_links.length > 0
  ).length;

  // results = merged view, starts from existing data.
  const results = existing.slice();
  const indexByUrl = new Map(results.map((r, i) => [r.url, i]));

  writeResults(results);
  renderStatus();

  if (queue.length === 0) {
    logAbove(
      MODE === 'retry'
        ? 'Nothing to retry — no failed books in the existing output.'
        : 'Nothing to do — every book already processed.'
    );
    return;
  }

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext();

  // When the browser dies/disconnects (crash, OOM, Ctrl+C) we stop the whole
  // run instead of marking every remaining book as failed. `intentionalClose`
  // distinguishes our own browser.close() at the end from a real crash.
  let aborted = false;
  let intentionalClose = false;
  browser.on('disconnected', () => {
    if (!intentionalClose) aborted = true;
  });

  // Spin up CONCURRENCY worker pages that each pull from the shared queue.
  let cursor = 0;
  let pendingWrites = 0;
  const writeIfIdle = () => {
    if (pendingWrites > 0) return;
    pendingWrites += 1;
    try {
      writeResults(results);
    } finally {
      pendingWrites -= 1;
    }
  };

  async function worker() {
    const page = await context.newPage();
    try {
      while (true) {
        const idx = cursor;
        if (idx >= queue.length) break;
        cursor += 1;
        const book = queue[idx];

        STATE.current = `${book.name} (${book.url})`;
        renderStatus();

        const entry = await processBook(page, book);

        if (indexByUrl.has(entry.url)) {
          results[indexByUrl.get(entry.url)] = entry;
        } else {
          indexByUrl.set(entry.url, results.length);
          results.push(entry);
        }

        STATE.done += 1;
        if (entry.error) {
          STATE.failed += 1;
          logAbove(`ERROR [${entry.url}]: ${entry.error}`);
        } else if (entry.download_links.length > 0) {
          STATE.withLinks += 1;
        }

        writeIfIdle();
        renderStatus();

        // Optional throttle between pages.
        if (DELAY_MS > 0 && cursor < queue.length) {
          await sleep(DELAY_MS);
        }
      }
    } finally {
      // The page may already be gone if the browser crashed.
      await page.close().catch(() => {});
    }
  }

  try {
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => worker())
    );
  } finally {
    writeResults(results);
    renderStatus();
    intentionalClose = true;
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  if (aborted) {
    logAbove(
      `Stopped early (browser closed). Processed ${STATE.done} books ` +
        `(failed: ${STATE.failed}, with-links: ${STATE.withLinks}) -> ${OUTPUT_FILE}`
    );
  } else {
    logAbove(
      `Done. Processed ${STATE.done} books ` +
        `(failed: ${STATE.failed}, with-links: ${STATE.withLinks}) -> ${OUTPUT_FILE}`
    );
  }
  const failedCount = results.filter(isFailed).length;
  logAbove(`Books without links / errored: ${failedCount} -> ${OUTPUT_FAILED_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
