// Initialize a Playwright workspace for a target website in 3 sequential
// steps. Each step is idempotent: if its expected output already exists,
// it is skipped so the function can be re-run safely.
//
//   Step 1: create the domain folder (e.g. "thuviensach.vn").
//   Step 2: run `yarn create playwright` inside that folder.
//   Step 3: create "Step 1", "Step 2" subfolders and a steps.json manifest
//           ({ steps: [{ name, folder }, ...] }). The runner lives in
//           lib/invoke.js and is shared by every project.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { t } = require('./i18n');

const DEFAULT_STEPS = [
  { name: 'Step 1', folder: 'Step 1' },
  { name: 'Step 2', folder: 'Step 2' },
];
const STEPS_FILE = 'steps.json';

function extractDomain(input) {
  let value = String(input || '').trim();
  if (!value) {
    throw new Error(t('errEmptyUrl'));
  }

  if (!/^https?:\/\//i.test(value)) {
    value = 'https://' + value;
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch (err) {
    throw new Error(t('errInvalidUrl', { input }));
  }

  return parsed.hostname.replace(/^www\./i, '');
}

function runCommand(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });

    child.on('error', (err) => {
      if (err && err.code === 'ENOENT') {
        reject(new Error(t('errCmdNotFound', { cmd })));
      } else {
        reject(err);
      }
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(t('exitCode', { cmd: cmd + ' ' + args.join(' '), code })));
      }
    });
  });
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (_err) {
    return false;
  }
}

async function step1CreateFolder(domainDir) {
  if (fs.existsSync(domainDir)) {
    if (!isDirectory(domainDir)) {
      throw new Error(t('errNotDir', { path: domainDir }));
    }
    console.log(t('step1Skip', { dir: domainDir }));
    return;
  }
  fs.mkdirSync(domainDir, { recursive: true });
  console.log(t('step1Created', { dir: domainDir }));
}

async function step2InitPlaywright(domainDir) {
  const playwrightConfigs = [
    'playwright.config.ts',
    'playwright.config.js',
    'playwright.config.mjs',
  ];
  const alreadyInitialized = playwrightConfigs.some((f) =>
    fs.existsSync(path.join(domainDir, f)),
  );

  if (alreadyInitialized) {
    console.log(t('step2Skip'));
    return;
  }

  console.log(t('step2Running'));
  await runCommand('yarn', ['create', 'playwright'], domainDir);
  console.log(t('step2Done'));
}

async function step3CreateStepStructure(domainDir) {
  const stepsFile = path.join(domainDir, STEPS_FILE);

  for (const step of DEFAULT_STEPS) {
    const dir = path.join(domainDir, step.folder);
    if (fs.existsSync(dir)) {
      if (!isDirectory(dir)) {
        throw new Error(t('errNotDir', { path: dir }));
      }
      console.log(t('step3SubSkip', { name: step.folder }));
    } else {
      fs.mkdirSync(dir, { recursive: true });
      console.log(t('step3SubCreated', { name: step.folder }));
    }
  }

  if (fs.existsSync(stepsFile)) {
    console.log(t('step3FileSkip', { file: STEPS_FILE }));
    return;
  }

  const manifest = { steps: DEFAULT_STEPS };
  fs.writeFileSync(stepsFile, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(t('step3FileWrote', { file: STEPS_FILE }));
}

async function initProject(urlOrDomain, rootDir) {
  const baseDir = rootDir || process.cwd();
  const domain = extractDomain(urlOrDomain);
  const domainDir = path.resolve(baseDir, domain);

  await step1CreateFolder(domainDir);
  await step2InitPlaywright(domainDir);
  await step3CreateStepStructure(domainDir);

  return { domain, domainDir };
}

module.exports = { initProject, extractDomain };
