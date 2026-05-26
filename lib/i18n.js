// Simple i18n layer. Translations are stored in-memory; the active locale
// is persisted in .crawler-config.json at the workspace root so the
// preference survives between runs of start.js.
//
// Use t(key, params) to format a string. Placeholders in messages use
// {name} syntax and are replaced from the params object.

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', '.crawler-config.json');

const translations = {
  vi: {
    chooseLang: 'Chọn ngôn ngữ / Select language:',
    langChanged: 'Đã đổi ngôn ngữ sang Tiếng Việt.',
    chooseProject: 'Chọn project hoặc init mới (↑/↓ và Enter):',
    noProjects: 'Chưa có project nào. Chọn một mục (↑/↓ và Enter):',
    initLabel: '+ Init project mới',
    changeLangLabel: '+ Đổi ngôn ngữ / Change language',
    cancelled: 'Đã huỷ.',
    enterUrl: 'Nhập trang web (ví dụ https://thuviensach.vn): ',
    emptyUrl: 'URL trống, đã huỷ.',
    initDone: 'Hoàn tất khởi tạo cho {domain}.',
    nextPrompt: 'Tiếp theo (↑/↓ và Enter):',
    runNow: 'Chạy {domain} ngay',
    exit: 'Thoát',
    runningInvoke: 'Đang mở {folder} ...',
    nodeNotFound: 'Không tìm thấy `node` trên PATH.',
    exitCode: '{cmd} thoát với mã {code}',

    chooseStep: 'Chọn step (↑/↓ và Enter):',
    stepsMissing: 'Không tìm thấy steps.json trong project.',
    stepsEmpty: 'steps.json không có step nào hợp lệ.',
    folderNotExist: 'Folder không tồn tại: {dir}',
    running: 'Đang chạy: {cmd}',

    step1Skip: '[Step 1] Thư mục đã tồn tại, bỏ qua: {dir}',
    step1Created: '[Step 1] Đã tạo thư mục: {dir}',
    step2Skip: '[Step 2] Playwright đã được cài, bỏ qua.',
    step2Running: '[Step 2] Đang chạy "yarn create playwright" ...',
    step2Done: '[Step 2] Cài đặt Playwright hoàn tất.',
    step3SubSkip: '[Step 3] Thư mục con đã tồn tại, bỏ qua: {name}',
    step3SubCreated: '[Step 3] Đã tạo thư mục con: {name}',
    step3FileSkip: '[Step 3] {file} đã tồn tại, bỏ qua.',
    step3FileWrote: '[Step 3] Đã tạo {file}',

    errEmptyUrl: 'URL trống.',
    errInvalidUrl: 'URL không hợp lệ: {input}',
    errNotDir: '"{path}" đã tồn tại nhưng không phải là thư mục.',
    errCmdNotFound: 'Không tìm thấy `{cmd}` trên PATH.',
  },
  en: {
    chooseLang: 'Select language / Chọn ngôn ngữ:',
    langChanged: 'Language switched to English.',
    chooseProject: 'Choose a project or init a new one (↑/↓ and Enter):',
    noProjects: 'No projects yet. Pick an option (↑/↓ and Enter):',
    initLabel: '+ Init new project',
    changeLangLabel: '+ Change language / Đổi ngôn ngữ',
    cancelled: 'Cancelled.',
    enterUrl: 'Enter website (e.g. https://thuviensach.vn): ',
    emptyUrl: 'Empty URL, cancelled.',
    initDone: 'Initialization done for {domain}.',
    nextPrompt: 'Next (↑/↓ and Enter):',
    runNow: 'Run {domain} now',
    exit: 'Exit',
    runningInvoke: 'Opening {folder} ...',
    nodeNotFound: '`node` not found on PATH.',
    exitCode: '{cmd} exited with code {code}',

    chooseStep: 'Choose a step (↑/↓ and Enter):',
    stepsMissing: 'steps.json not found in project.',
    stepsEmpty: 'steps.json has no valid steps.',
    folderNotExist: 'Folder does not exist: {dir}',
    running: 'Running: {cmd}',

    step1Skip: '[Step 1] Folder already exists, skipping: {dir}',
    step1Created: '[Step 1] Created folder: {dir}',
    step2Skip: '[Step 2] Playwright already initialized, skipping.',
    step2Running: '[Step 2] Running "yarn create playwright" ...',
    step2Done: '[Step 2] Playwright initialization done.',
    step3SubSkip: '[Step 3] Subfolder already exists, skipping: {name}',
    step3SubCreated: '[Step 3] Created subfolder: {name}',
    step3FileSkip: '[Step 3] {file} already exists, skipping.',
    step3FileWrote: '[Step 3] Wrote {file}',

    errEmptyUrl: 'URL is empty.',
    errInvalidUrl: 'Invalid URL: {input}',
    errNotDir: '"{path}" already exists and is not a directory.',
    errCmdNotFound: '`{cmd}` not found on PATH.',
  },
};

const LANG_LABELS = {
  vi: 'Tiếng Việt',
  en: 'English',
};

let currentLang = 'vi';

function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      if (data && data.lang && translations[data.lang]) {
        currentLang = data.lang;
      }
    } catch (_err) {
      // Ignore malformed config and fall back to defaults.
    }
  }
}

function saveConfig() {
  const data = { lang: currentLang };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function getLang() {
  return currentLang;
}

function setLang(lang, persist = true) {
  if (translations[lang]) {
    currentLang = lang;
    if (persist) saveConfig();
  }
}

function hasConfig() {
  return fs.existsSync(CONFIG_PATH);
}

function format(template, params) {
  if (!params) return template;
  let out = template;
  for (const k of Object.keys(params)) {
    out = out.replace(new RegExp('\\{' + k + '\\}', 'g'), String(params[k]));
  }
  return out;
}

function t(key, params) {
  const dict = translations[currentLang] || translations.vi;
  const fallback = translations.vi;
  const template = dict[key] != null ? dict[key] : (fallback[key] != null ? fallback[key] : key);
  return format(template, params);
}

module.exports = {
  t,
  getLang,
  setLang,
  loadConfig,
  saveConfig,
  hasConfig,
  supportedLangs: Object.keys(translations),
  LANG_LABELS,
  CONFIG_PATH,
};
