// Step: get book links from every category in result/categories.json.
//
// For each category link we:
//   1. Open the category page.
//   2. Read pagination info (total_pages + per-page URLs) from
//      nav.woocommerce-pagination. If no pagination is found we treat the
//      category as a single-page listing using the current URL.
//   3. Visit every paginated URL and extract the book name + URL from each
//      product card inside `.products.row > .product`.
//
// Output:
//   <project-root>/result/book_links_by_category.json
//     Per-category breakdown including pagination metadata.
//   <project-root>/result/book_links.json
//     Flat list of unique books (deduplicated by url), written once at the
//     end of the run.
//
// The by-category file is rewritten after every category so partial data is
// kept even if the run is interrupted.
//
// Optional CLI flags:
//   --max-categories=N   only process the first N categories
//   --max-pages=N        cap pages per category (useful for smoke tests)
//   --start=N            skip the first N categories (resume support)
//   --headed             run with a visible browser window

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const INPUT_FILE = path.join(PROJECT_ROOT, 'result', 'categories.json');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'result');
const OUTPUT_BY_CATEGORY = path.join(OUTPUT_DIR, 'book_links_by_category.json');
const OUTPUT_UNIQUE = path.join(OUTPUT_DIR, 'book_links.json');

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
const MAX_CATEGORIES = ARGS['max-categories']
  ? parseInt(ARGS['max-categories'], 10)
  : Infinity;
const MAX_PAGES = ARGS['max-pages']
  ? parseInt(ARGS['max-pages'], 10)
  : Infinity;
const START_FROM = ARGS['start'] ? parseInt(ARGS['start'], 10) : 0;
const HEADLESS = !ARGS['headed'];

const IS_TTY = Boolean(process.stdout.isTTY);
const STATUS_LINES = 3;
let statusRendered = false;

const STATE = {
  catIndex: 0,
  catTotal: 0,
  catName: '',
  pageIndex: 0,
  totalPages: 0,
  pageUrl: '-',
};

// Render the 3-line live status block, redrawing in-place on TTYs.
function renderStatus() {
  const lines = [
    `Category : ${STATE.catIndex}/${STATE.catTotal}  —  ${STATE.catName}`,
    `Page     : ${STATE.pageIndex}/${STATE.totalPages}`,
    `URL      : ${STATE.pageUrl}`,
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

// Print a permanent message above the live status block (used for errors
// and milestones). After printing, the next renderStatus() call will draw
// fresh 3 lines below this message.
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

// Read pagination info from the current page.
async function readPagination(page) {
  return page.evaluate(() => {
    const pagination = document.querySelector('nav.woocommerce-pagination');
    if (!pagination) return { error: 'Không tìm thấy element phân trang' };

    const infoText =
      pagination.querySelector('.middle_link')?.textContent || '';
    const totalMatch = infoText.match(/\/(\d+)/);
    const totalPages = totalMatch ? parseInt(totalMatch[1], 10) : 0;

    const sampleLink = pagination
      .querySelector('a[href*="/page/"]')
      ?.getAttribute('href');
    let baseUrl = '';
    if (sampleLink) {
      baseUrl = sampleLink.split('/page/')[0];
    } else {
      baseUrl = window.location.pathname
        .replace(/\/page\/\d+/, '')
        .replace(/\/$/, '');
    }

    const pageLinks = [];
    const fullBaseUrl = window.location.origin + baseUrl;
    for (let i = 1; i <= totalPages; i += 1) {
      pageLinks.push({
        page: i,
        url: i === 1 ? `${fullBaseUrl}/` : `${fullBaseUrl}/page/${i}/`,
      });
    }

    return { total_pages: totalPages, links: pageLinks };
  });
}

// Extract every book listed on the current page.
async function extractBooks(page) {
  return page.evaluate(() => {
    const products = Array.from(
      document.querySelectorAll('.products.row > .product')
    );
    return products.map((product) => {
      const titleElement =
        product.querySelector('.woocommerce-loop-product__title') ||
        product.querySelector('h2') ||
        product.querySelector('h3');
      const linkElement =
        product.querySelector('a.woocommerce-LoopProduct-link') ||
        product.querySelector('a');
      return {
        name: titleElement ? titleElement.innerText.trim() : 'N/A',
        url: linkElement ? linkElement.href : 'N/A',
      };
    });
  });
}

function writeResults(results) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(
    OUTPUT_BY_CATEGORY,
    JSON.stringify(results, null, 2),
    'utf8'
  );
}

// Build a flat, deduplicated list of books (keyed by url) from the
// per-category results and write it to OUTPUT_UNIQUE.
function writeUniqueBooks(results) {
  const seen = new Map();
  for (const entry of results) {
    for (const book of entry.books) {
      if (!book.url || book.url === 'N/A') continue;
      if (!seen.has(book.url)) {
        seen.set(book.url, { name: book.name, url: book.url });
      }
    }
  }
  const unique = Array.from(seen.values());
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_UNIQUE, JSON.stringify(unique, null, 2), 'utf8');
  return unique.length;
}

async function processCategory(page, category, ctx) {
  const { catIndex, catTotal } = ctx;
  const result = {
    category,
    total_pages: 0,
    pages_scraped: 0,
    books: [],
    error: null,
  };

  STATE.catIndex = catIndex;
  STATE.catTotal = catTotal;
  STATE.catName = category.name;
  STATE.pageIndex = 0;
  STATE.totalPages = 0;
  STATE.pageUrl = category.link;
  renderStatus();

  try {
    await page.goto(category.link, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });
  } catch (err) {
    result.error = `goto failed: ${err.message}`;
    logAbove(`ERROR [cat ${catIndex}/${catTotal} "${category.name}"]: ${err.message}`);
    return result;
  }

  const pagination = await readPagination(page);
  let pageLinks;
  if (pagination.error || !pagination.total_pages) {
    pageLinks = [{ page: 1, url: page.url() }];
    result.total_pages = 1;
  } else {
    pageLinks = pagination.links;
    result.total_pages = pagination.total_pages;
  }

  const limited = pageLinks.slice(0, MAX_PAGES);
  STATE.totalPages = limited.length;

  for (let p = 0; p < limited.length; p += 1) {
    const pageInfo = limited[p];
    STATE.pageIndex = p + 1;
    STATE.pageUrl = pageInfo.url;
    renderStatus();

    try {
      if (pageInfo.url !== page.url()) {
        await page.goto(pageInfo.url, {
          waitUntil: 'domcontentloaded',
          timeout: 45_000,
        });
      }
      const books = await extractBooks(page);
      for (const book of books) {
        result.books.push({ ...book, page: pageInfo.page });
      }
      result.pages_scraped += 1;
    } catch (err) {
      result.error = `page ${pageInfo.page} failed: ${err.message}`;
      logAbove(
        `ERROR [cat ${catIndex}/${catTotal} "${category.name}" page ${pageInfo.page}]: ${err.message}`
      );
      break;
    }
  }

  return result;
}

async function main() {
  if (!fs.existsSync(INPUT_FILE)) {
    throw new Error(
      `Missing ${INPUT_FILE}. Run the "get categories" step first.`
    );
  }

  const categories = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));
  const queue = categories.slice(START_FROM, START_FROM + MAX_CATEGORIES);

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext();
  const page = await context.newPage();

  const results = [];
  try {
    for (let i = 0; i < queue.length; i += 1) {
      const category = queue[i];
      const result = await processCategory(page, category, {
        catIndex: i + 1,
        catTotal: queue.length,
      });
      results.push(result);
      writeResults(results);
    }
  } finally {
    await context.close();
    await browser.close();
  }

  const totalBooks = results.reduce((sum, r) => sum + r.books.length, 0);
  const uniqueCount = writeUniqueBooks(results);
  const failed = results.filter((r) => r.error).length;
  logAbove(
    `Done. ${results.length} categories (${failed} errors), ${totalBooks} books ` +
      `-> ${OUTPUT_BY_CATEGORY}`
  );
  logAbove(`Unique books: ${uniqueCount} -> ${OUTPUT_UNIQUE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
