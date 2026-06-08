// Step: download every file listed in result/download_links.json.
//
// For each link we:
//   1. Issue a GET via Playwright's APIRequestContext (follows redirects,
//      mirrors a real browser session). Most links bounce through Google
//      Drive and end on `drive.usercontent.google.com`.
//   2. Read the filename from `Content-Disposition` (with a sanitized
//      fallback derived from the URL + a content-type extension).
//   3. Stream the response body to <project-root>/result/downloaded/<file>.
//   4. Append the link to result/download_log.jsonl once it finishes.
//
// Before downloading, each link is checked against that log; links already
// present are skipped. Files that already exist on disk are also skipped, so
// the run is resumable. Use --overwrite to ignore both checks and re-download.
//
// Parallelism:
//   The script prompts for the number of parallel threads (default 1).
//   You can skip the prompt with --threads=N. Playwright APIRequestContext
//   is fully thread-safe — concurrent requests share the same context but
//   each request is independent.
//
// Optional CLI flags:
//   --threads=N    number of parallel downloads (skips the prompt)
//   --delay=S      delay in seconds between downloads on the same worker
//                  (skips the prompt; default 1, accepts decimals like 0.5)
//   --max=N        only download the first N links
//   --start=N      skip the first N links
//   --overwrite    re-download files that already exist on disk

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { request } = require('playwright');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const INPUT_FILE = path.join(PROJECT_ROOT, 'result', 'download_links.json');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'result', 'downloaded');
// Append-only log (JSON Lines) recording every link that finished downloading.
// On startup we read it back so already-downloaded links are skipped, making
// the run resumable even if the downloaded files are moved or renamed.
const LOG_FILE = path.join(PROJECT_ROOT, 'result', 'download_log.jsonl');

const DEFAULT_THREADS = 1;
const MAX_THREADS = 32;
const DEFAULT_DELAY_SEC = 1;
const MAX_DELAY_SEC = 600; // 10 minutes — generous upper bound for safety
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes per file

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
const MAX_LINKS = ARGS['max'] ? parseInt(ARGS['max'], 10) : Infinity;
const START_FROM = ARGS['start'] ? parseInt(ARGS['start'], 10) : 0;
const OVERWRITE = Boolean(ARGS['overwrite']);

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(String(answer).trim());
    });
  });
}

async function resolveThreadCount() {
  if (ARGS['threads'] !== undefined) {
    const n = parseInt(ARGS['threads'], 10);
    if (!Number.isFinite(n) || n < 1) {
      console.error(`--threads must be a positive integer (got "${ARGS['threads']}")`);
      process.exit(1);
    }
    return Math.min(n, MAX_THREADS);
  }
  if (!process.stdin.isTTY) {
    return DEFAULT_THREADS;
  }
  const answer = await ask(
    `Số luồng parallel (1-${MAX_THREADS}, Enter để dùng mặc định ${DEFAULT_THREADS}): `
  );
  if (!answer) return DEFAULT_THREADS;
  const n = parseInt(answer, 10);
  if (!Number.isFinite(n) || n < 1) {
    console.log(`Giá trị không hợp lệ, dùng mặc định ${DEFAULT_THREADS}.`);
    return DEFAULT_THREADS;
  }
  return Math.min(n, MAX_THREADS);
}

async function resolveDelayMs() {
  if (ARGS['delay'] !== undefined) {
    const sec = Number(ARGS['delay']);
    if (!Number.isFinite(sec) || sec < 0) {
      console.error(`--delay must be a non-negative number (got "${ARGS['delay']}")`);
      process.exit(1);
    }
    return Math.min(sec, MAX_DELAY_SEC) * 1000;
  }
  if (!process.stdin.isTTY) {
    return DEFAULT_DELAY_SEC * 1000;
  }
  const answer = await ask(
    `Delay giữa các lần download (giây, Enter để dùng mặc định ${DEFAULT_DELAY_SEC}): `
  );
  if (!answer) return DEFAULT_DELAY_SEC * 1000;
  const sec = Number(answer);
  if (!Number.isFinite(sec) || sec < 0) {
    console.log(`Giá trị không hợp lệ, dùng mặc định ${DEFAULT_DELAY_SEC}s.`);
    return DEFAULT_DELAY_SEC * 1000;
  }
  return Math.min(sec, MAX_DELAY_SEC) * 1000;
}

function sleep(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Read the download log and return a Set of links already downloaded.
// Tolerates a missing file and skips any malformed lines.
function loadDownloadedLinks() {
  const done = new Set();
  if (!fs.existsSync(LOG_FILE)) return done;
  const content = fs.readFileSync(LOG_FILE, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed);
      if (entry && entry.link) done.add(entry.link);
    } catch (_err) {
      // Ignore corrupt lines so a partial write can't break the next run.
    }
  }
  return done;
}

// Append one record to the log. appendFileSync is blocking, and Node runs JS
// single-threaded, so concurrent workers can't interleave a partial write.
function appendToLog(entry) {
  fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
}

// Live status block, redrawn in-place on TTYs.
const IS_TTY = Boolean(process.stdout.isTTY);
const STATE = {
  done: 0,
  total: 0,
  ok: 0,
  failed: 0,
  skipped: 0,
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
    `Progress : ${STATE.done}/${STATE.total}  ` +
      `(ok: ${STATE.ok}, failed: ${STATE.failed}, skipped: ${STATE.skipped})`,
    `Total    : ${fmtBytes(STATE.bytes)} downloaded`,
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
  // Clear any leftover lines from the previous, taller render.
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

// Sanitize a filename so it's safe across Linux/macOS/Windows filesystems.
function sanitizeFilename(name) {
  // Strip path separators and control characters; collapse whitespace.
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
    return (plain[2] || plain[3] || '').trim();
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
};

function fallbackName(url, contentType) {
  let stem;
  try {
    const u = new URL(url);
    stem = u.pathname.split('/').filter(Boolean).pop() || u.hostname;
  } catch (_err) {
    stem = 'file';
  }
  const ext =
    EXT_FROM_TYPE[(contentType || '').split(';')[0].trim().toLowerCase()] ||
    '';
  return sanitizeFilename(stem) + ext;
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

async function downloadOne(reqCtx, item, slotId) {
  const slot = { id: slotId, label: item.title || item.link };
  STATE.active.push(slot);
  renderStatus();

  const result = { link: item.link, ok: false, file: null, error: null };

  try {
    const response = await reqCtx.get(item.link, {
      timeout: REQUEST_TIMEOUT_MS,
      maxRedirects: 20,
    });

    if (!response.ok()) {
      result.error = `HTTP ${response.status()} ${response.statusText()}`;
      return result;
    }

    const headers = response.headers();
    const dispositionName = filenameFromContentDisposition(
      headers['content-disposition']
    );
    const baseName = dispositionName
      ? sanitizeFilename(dispositionName)
      : fallbackName(item.link, headers['content-type']);

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    let target = path.join(OUTPUT_DIR, baseName);
    if (fs.existsSync(target) && !OVERWRITE) {
      result.ok = true;
      result.file = target;
      result.skipped = true;
      // The file already has data on disk; report its real size instead of 0.
      result.bytes = fs.statSync(target).size;
      return result;
    }
    if (OVERWRITE && fs.existsSync(target)) {
      fs.unlinkSync(target);
    } else if (!OVERWRITE) {
      // baseName may collide with a queued sibling; ensure uniqueness.
      const uniqueName = uniqueFilename(OUTPUT_DIR, baseName);
      target = path.join(OUTPUT_DIR, uniqueName);
    }

    const body = await response.body();
    fs.writeFileSync(target, body);

    result.ok = true;
    result.file = target;
    result.bytes = body.length;
    return result;
  } catch (err) {
    result.error = err.message || String(err);
    return result;
  } finally {
    const idx = STATE.active.indexOf(slot);
    if (idx !== -1) STATE.active.splice(idx, 1);
  }
}

async function main() {
  if (!fs.existsSync(INPUT_FILE)) {
    throw new Error(
      `Missing ${INPUT_FILE}. Run the "get download links" step first.`
    );
  }

  const all = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));
  const selected = all
    .slice(START_FROM, START_FROM + MAX_LINKS)
    .filter((x) => x && x.link);

  // Links recorded in the log are considered done and updated by all workers
  // during the run. Filter them out up front (unless --overwrite) so the queue
  // only contains links that still need downloading.
  const downloadedLinks = loadDownloadedLinks();
  const queue = OVERWRITE
    ? selected
    : selected.filter((x) => !downloadedLinks.has(x.link));
  const alreadyDone = selected.length - queue.length;

  if (queue.length === 0) {
    console.log(
      `Nothing to download. ${selected.length} link đã có trong log ${LOG_FILE}.`
    );
    return;
  }

  const threads = await resolveThreadCount();
  const delayMs = await resolveDelayMs();
  const delayDesc =
    delayMs === 0 ? 'không delay' : `delay ${delayMs / 1000}s giữa các lần tải`;

  console.log(
    `Sẽ tải ${queue.length} file vào ${OUTPUT_DIR} với ${threads} luồng song song (${delayDesc}).`
  );
  console.log(
    `(Đã lọc bỏ ${alreadyDone} link đã có trong log ${LOG_FILE}, dùng --overwrite để tải lại.)`
  );
  console.log('');

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  STATE.total = queue.length;
  renderStatus();

  // One shared APIRequestContext — Playwright handles concurrency safely.
  const reqCtx = await request.newContext({
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    extraHTTPHeaders: {
      Referer: 'https://thuviensach.vn/',
    },
  });

  let cursor = 0;
  async function worker(slotId) {
    let isFirst = true;
    while (true) {
      const idx = cursor;
      if (idx >= queue.length) break;
      cursor += 1;

      // Wait before every download except the first one in this worker.
      // Skipped (already-on-disk) downloads still count as a "step" so the
      // delay also throttles re-scans, but they're fast so it's harmless.
      if (!isFirst) {
        await sleep(delayMs);
      }
      isFirst = false;

      const item = queue[idx];
      const result = await downloadOne(reqCtx, item, slotId);

      STATE.done += 1;
      if (result.ok) {
        if (result.skipped) {
          STATE.skipped += 1;
        } else {
          STATE.ok += 1;
        }
        // Count bytes for both fresh and already-on-disk files.
        STATE.bytes += result.bytes || 0;
        // Record the link as downloaded so subsequent runs skip it.
        downloadedLinks.add(item.link);
        appendToLog({
          link: item.link,
          title: item.title || null,
          file: result.file ? path.basename(result.file) : null,
          bytes: result.bytes || 0,
          skipped: Boolean(result.skipped),
          time: new Date().toISOString(),
        });
      } else {
        STATE.failed += 1;
        logAbove(`ERROR [${item.link}]: ${result.error}`);
      }
      renderStatus();
    }
  }

  try {
    await Promise.all(
      Array.from({ length: Math.min(threads, queue.length) }, (_, i) =>
        worker(i + 1)
      )
    );
  } finally {
    await reqCtx.dispose();
  }

  renderStatus();
  logAbove(
    `Done. ${STATE.done}/${STATE.total} processed ` +
      `(ok: ${STATE.ok}, skipped: ${STATE.skipped}, failed: ${STATE.failed}, ` +
      `${fmtBytes(STATE.bytes)} downloaded) -> ${OUTPUT_DIR}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
