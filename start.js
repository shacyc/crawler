#!/usr/bin/env node

// Unified entry point. Scans the current directory for existing project
// folders (those containing steps.json) and presents them in a single
// interactive menu together with a trailing "create new project" option
// and a "change language" option.
//
//   - Pick an existing folder    -> invoke() into it using lib/invoke.js.
//   - Pick "+ Init project mới"  -> prompt for a URL and call initProject().
//   - Pick "+ Đổi ngôn ngữ"      -> switch language and persist it.

const fs = require('fs');
const path = require('path');

const { selectFromList, ask } = require('./lib/select');
const { initProject } = require('./lib/init');
const { invoke } = require('./lib/invoke');
const {
  t,
  setLang,
  loadConfig,
  hasConfig,
  supportedLangs,
  LANG_LABELS,
} = require('./lib/i18n');

const STEPS_FILE = 'steps.json';

function listProjectFolders(rootDir) {
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  return entries
    .filter((entry) => {
      if (!entry.isDirectory()) return false;
      if (entry.name.startsWith('.')) return false;
      if (entry.name === 'node_modules' || entry.name === 'lib') return false;
      return fs.existsSync(path.join(rootDir, entry.name, STEPS_FILE));
    })
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

async function chooseLanguage() {
  const items = supportedLangs.map((l) => LANG_LABELS[l]);
  const chosen = await selectFromList(t('chooseLang'), items);
  if (!chosen) return;
  const lang = supportedLangs.find((l) => LANG_LABELS[l] === chosen);
  if (lang) {
    setLang(lang);
    console.log(t('langChanged'));
  }
}

async function handleInit(rootDir) {
  const url = await ask(t('enterUrl'));
  if (!url) {
    console.error(t('emptyUrl'));
    process.exit(1);
  }

  const { domain, domainDir } = await initProject(url, rootDir);
  console.log('\n' + t('initDone', { domain }));

  const next = await selectFromList(t('nextPrompt'), [
    t('runNow', { domain }),
    t('exit'),
  ]);
  if (next === t('runNow', { domain })) {
    await invoke(domainDir);
  }
}

async function main() {
  loadConfig();

  if (!hasConfig()) {
    await chooseLanguage();
  }

  const rootDir = process.cwd();
  const folders = listProjectFolders(rootDir);

  const initLabel = t('initLabel');
  const langLabel = t('changeLangLabel');
  const items = [...folders, initLabel, langLabel];

  const heading = folders.length === 0 ? t('noProjects') : t('chooseProject');
  const chosen = await selectFromList(heading, items);
  if (!chosen) {
    console.error(t('cancelled'));
    process.exit(1);
  }

  if (chosen === initLabel) {
    await handleInit(rootDir);
    return;
  }

  if (chosen === langLabel) {
    await chooseLanguage();
    await main();
    return;
  }

  const folderDir = path.join(rootDir, chosen);
  console.log(t('runningInvoke', { folder: chosen }));
  await invoke(folderDir);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
