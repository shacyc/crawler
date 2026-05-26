// Step: get categories from https://thuviensach.vn/
// Navigates to the homepage, collects every category link inside #div_form2,
// and writes the result to <project-root>/result/categories.json
// (inside the thuviensach.vn project folder).

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const TARGET_URL = 'https://thuviensach.vn/';
// __dirname = .../crawler/thuviensach.vn/get_categories
// Go up one level to reach the thuviensach.vn project root, then into ./result
const OUTPUT_DIR = path.resolve(__dirname, '..', 'result');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'categories.json');

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    console.log(`Opening ${TARGET_URL} ...`);
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });

    // Make sure the category container is present before scraping.
    await page.waitForSelector('#div_form2 a', { timeout: 30_000 });

    const categories = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('#div_form2 a')).map((a) => ({
        name: a.innerText.trim() || a.getAttribute('title') || 'Không có tên',
        link: a.href,
      }));
    });

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(categories, null, 2), 'utf8');

    console.log(`Saved ${categories.length} categories to ${OUTPUT_FILE}`);
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
