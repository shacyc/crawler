// Step: get download links from every book in result/book_links.json.
//
// For each book we:
//   1. Open the book page.
//   2. Look for `fieldset#type` and read every `<a>` inside it. Each anchor
//      becomes { link, title } where title falls back to the anchor text.
//
// Output:
//   <project-root>/result/download_links_by_book.json
//     Per-book breakdown (kept for resumability + debugging).
//   <project-root>/result/download_links.json
//     Flat list of unique download links (deduplicated by `link`).
//
// The by-book file is rewritten after every book so partial data survives
// interruptions. Re-running with --resume skips books that already have an
// entry there.
//
// Optional CLI flags:
//   --max-books=N   only process the first N books (after --start offset)
//   --start=N       skip the first N books (resume support)
//   --resume        skip URLs that already exist in the by-book output
//   --concurrency=N open N parallel pages (default 3)
//   --headed        run with a visible browser window

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const INPUT_FILE = path.join(PROJECT_ROOT, 'result', 'book_links.json');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'result');
const OUTPUT_BY_BOOK = path.join(OUTPUT_DIR, 'download_links_by_book.json');
const OUTPUT_UNIQUE = path.join(OUTPUT_DIR, 'download_links.json');

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
const MAX_BOOKS = ARGS['max-books']
  ? parseInt(ARGS['max-books'], 10)
  : Infinity;
const START_FROM = ARGS['start'] ? parseInt(ARGS['start'], 10) : 0;
const CONCURRENCY = ARGS['concurrency']
  ? Math.max(1, parseInt(ARGS['concurrency'], 10))
  : 3;
const HEADLESS = !ARGS['headed'];
const RESUME = Boolean(ARGS['resume']);

const IS_TTY = Boolean(process.stdout.isTTY);
const STATUS_LINES = 4;
let statusRendered = false;

const STATE = {
  done: 0,
  total: 0,
  failed: 0,
  withLinks: 0,
  uniqueLinks: 0,
  current: '-',
};

// Render the live status block, redrawing in-place on TTYs.
function renderStatus() {
  const lines = [
    `Books    : ${STATE.done}/${STATE.total}  (failed: ${STATE.failed})`,
    `WithLink : ${STATE.withLinks}`,
    `Unique   : ${STATE.uniqueLinks}`,
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

// Extract every download link from fieldset#type on the current page.
async function extractDownloads(page) {
  return page.evaluate(() => {
    const fieldset = document.querySelector('fieldset#type');
    if (!fieldset) return null;
    const anchors = fieldset.querySelectorAll('a');
    return Array.from(anchors).map((a) => ({
      link: a.href,
      title: a.title || a.innerText.trim(),
    }));
  });
}

function loadExistingResults() {
  if (!fs.existsSync(OUTPUT_BY_BOOK)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(OUTPUT_BY_BOOK, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (err) {
    logAbove(
      `Warning: ${OUTPUT_BY_BOOK} is not valid JSON, starting from scratch.`
    );
    return [];
  }
}

function writeByBook(results) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_BY_BOOK, JSON.stringify(results, null, 2), 'utf8');
}

// Build a flat, deduplicated list of download links from the per-book
// results and write it to OUTPUT_UNIQUE. Returns the unique count.
function writeUniqueLinks(results) {
  const seen = new Map();
  for (const entry of results) {
    if (!entry || !Array.isArray(entry.downloads)) continue;
    for (const d of entry.downloads) {
      if (!d || !d.link) continue;
      if (!seen.has(d.link)) {
        seen.set(d.link, { link: d.link, title: d.title || '' });
      }
    }
  }
  const unique = Array.from(seen.values());
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_UNIQUE, JSON.stringify(unique, null, 2), 'utf8');
  return unique.length;
}

async function processBook(page, book) {
  const entry = {
    name: book.name,
    url: book.url,
    downloads: [],
    error: null,
  };

  try {
    await page.goto(book.url, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });
  } catch (err) {
    entry.error = `goto failed: ${err.message}`;
    return entry;
  }

  try {
    const downloads = await extractDownloads(page);
    if (downloads === null) {
      // fieldset#type missing — not an error per se, just no download links.
      entry.downloads = [];
    } else {
      entry.downloads = downloads.filter((d) => d && d.link);
    }
  } catch (err) {
    entry.error = `extract failed: ${err.message}`;
  }

  return entry;
}

async function main() {
  if (!fs.existsSync(INPUT_FILE)) {
    throw new Error(
      `Missing ${INPUT_FILE}. Run the "get books" step first.`
    );
  }

  const books = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));
  const sliced = books.slice(START_FROM, START_FROM + MAX_BOOKS);

  // Load existing per-book results so we can resume / merge.
  const existing = loadExistingResults();
  const existingByUrl = new Map(existing.map((e) => [e.url, e]));

  // Build the queue: skip URLs already done when --resume is set.
  const queue = [];
  for (const book of sliced) {
    if (!book || !book.url) continue;
    if (RESUME && existingByUrl.has(book.url)) {
      const prev = existingByUrl.get(book.url);
      if (!prev.error) continue; // already done successfully, skip
    }
    queue.push(book);
  }

  STATE.total = queue.length;
  STATE.done = 0;
  STATE.failed = 0;
  STATE.withLinks = existing.filter(
    (e) => Array.isArray(e.downloads) && e.downloads.length > 0
  ).length;

  // results = merged view, starts from existing data.
  const results = existing.slice();
  const indexByUrl = new Map(results.map((r, i) => [r.url, i]));

  STATE.uniqueLinks = writeUniqueLinks(results);
  renderStatus();

  if (queue.length === 0) {
    logAbove('Nothing to do — every book already processed.');
    return;
  }

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext();

  // Spin up CONCURRENCY worker pages that each pull from the shared queue.
  let cursor = 0;
  let pendingWrites = 0;
  const writeIfIdle = () => {
    if (pendingWrites > 0) return;
    pendingWrites += 1;
    try {
      writeByBook(results);
      STATE.uniqueLinks = writeUniqueLinks(results);
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
        } else if (entry.downloads.length > 0) {
          STATE.withLinks += 1;
        }

        writeIfIdle();
        renderStatus();
      }
    } finally {
      await page.close();
    }
  }

  try {
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () =>
        worker()
      )
    );
  } finally {
    writeByBook(results);
    STATE.uniqueLinks = writeUniqueLinks(results);
    renderStatus();
    await context.close();
    await browser.close();
  }

  logAbove(
    `Done. Processed ${STATE.done} books ` +
      `(failed: ${STATE.failed}, with-links: ${STATE.withLinks}) -> ${OUTPUT_BY_BOOK}`
  );
  logAbove(`Unique download links: ${STATE.uniqueLinks} -> ${OUTPUT_UNIQUE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
