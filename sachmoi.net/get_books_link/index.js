// Step: get book links from https://sachmoi.net/
//
// Flow:
//   1. Open the sachmoi.net homepage.
//   2. Read the total number of pages from the pagination block (the last
//      numbered page link, i.e. the one right before the "next" arrow).
//   3. Walk every page from 1 to total_pages using the
//      https://sachmoi.net/trang/{page} URL pattern.
//   4. On each page, extract every book inside an <article> element
//      (id, name, url, thumbnail).
//   5. Aggregate all books across all pages into a single result file.
//
// Output:
//   <project-root>/result/book_links.json
//     Flat list of unique books (deduplicated by url), rewritten after every
//     page so partial data survives an interrupted run.
//
// Optional CLI flags:
//   --max-pages=N   only process the first N pages (useful for smoke tests)
//   --start=N       start from page N instead of page 1 (resume support)
//   --headed        run with a visible browser window

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const BASE_URL = 'https://sachmoi.net';
const PROJECT_ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'result');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'book_links.json');

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
const MAX_PAGES = ARGS['max-pages'] ? parseInt(ARGS['max-pages'], 10) : Infinity;
const START_FROM = ARGS['start'] ? parseInt(ARGS['start'], 10) : 1;
const HEADLESS = !ARGS['headed'];

const IS_TTY = Boolean(process.stdout.isTTY);
const STATUS_LINES = 3;
let statusRendered = false;

const STATE = {
  pageIndex: 0,
  totalPages: 0,
  pageUrl: '-',
  booksFound: 0,
};

// Render the 3-line live status block, redrawing in-place on TTYs.
function renderStatus() {
  const lines = [
    `Page  : ${STATE.pageIndex}/${STATE.totalPages}`,
    `Books : ${STATE.booksFound}`,
    `URL   : ${STATE.pageUrl}`,
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

// Print a permanent message above the live status block (errors/milestones).
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

// Read the total number of pages from the pagination block. The last numbered
// page link is the one immediately before the ".next" arrow.
async function readTotalPages(page) {
  return page.evaluate(() => {
    const lastNumbered = document.querySelector(
      '.pagination.loop-pagination a.page-numbers:has(+ .next.page-numbers)'
    );
    if (lastNumbered) {
      const total = parseInt(lastNumbered.textContent.trim().replace(/[^\d]/g, ''), 10);
      if (Number.isFinite(total) && total > 0) return total;
    }

    // Fallback: take the max of every numbered page link on the page.
    const numbers = Array.from(
      document.querySelectorAll('.pagination.loop-pagination a.page-numbers')
    )
      .map((a) => parseInt(a.textContent.trim().replace(/[^\d]/g, ''), 10))
      .filter((n) => Number.isFinite(n));
    return numbers.length ? Math.max(...numbers) : 1;
  });
}

// Extract every book listed on the current page.
async function extractBooks(page) {
  return page.evaluate(() => {
    const articles = document.querySelectorAll('article');
    const results = [];

    articles.forEach((article) => {
      const linkElement = article.querySelector('h2 a, h3 a, .entry-title a');
      const name = linkElement ? linkElement.textContent.trim() : 'N/A';
      const url = linkElement ? linkElement.href : 'N/A';

      const imgElement = article.querySelector('img');
      let thumbnail = 'N/A';
      if (imgElement) {
        thumbnail =
          imgElement.dataset.src ||
          imgElement.dataset.lazySrc ||
          imgElement.src;
      }

      results.push({
        id: article.id,
        name,
        url,
        thumbnail,
      });
    });

    return results;
  });
}

// Build the page URL for a given page number.
function pageUrl(pageNumber) {
  return `${BASE_URL}/trang/${pageNumber}`;
}

// Write the flat, deduplicated (by url) list of books to OUTPUT_FILE.
function writeBooks(booksByUrl) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(
    OUTPUT_FILE,
    JSON.stringify(Array.from(booksByUrl.values()), null, 2),
    'utf8'
  );
}

async function main() {
  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext();
  const page = await context.newPage();

  const booksByUrl = new Map();

  try {
    logAbove(`Opening ${BASE_URL} ...`);
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });

    const totalPages = await readTotalPages(page);
    logAbove(`Total pages: ${totalPages}`);

    const lastPage = Math.min(totalPages, START_FROM + MAX_PAGES - 1);
    STATE.totalPages = totalPages;

    for (let p = START_FROM; p <= lastPage; p += 1) {
      const url = pageUrl(p);
      STATE.pageIndex = p;
      STATE.pageUrl = url;
      renderStatus();

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        const books = await extractBooks(page);
        for (const book of books) {
          if (!book.url || book.url === 'N/A') continue;
          if (!booksByUrl.has(book.url)) booksByUrl.set(book.url, book);
        }
        STATE.booksFound = booksByUrl.size;
        renderStatus();
      } catch (err) {
        logAbove(`ERROR [page ${p}]: ${err.message}`);
      }

      writeBooks(booksByUrl);
    }
  } finally {
    await context.close();
    await browser.close();
  }

  logAbove(`Done. ${booksByUrl.size} unique books -> ${OUTPUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
