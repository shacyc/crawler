// Shared step runner. Called by start.js with the chosen project folder.
// Reads <projectDir>/steps.json (new schema = array of { name, folder };
// legacy schema = array of strings is normalized on the fly), prompts the
// user to pick a step, then runs the Playwright code located in the
// corresponding folder.
//
// Each Step folder is treated as a Playwright test directory: any
// .spec.js / .spec.ts / .test.js / .test.ts file inside it will be picked
// up by `npx playwright test`. You can also drop a plain script named
// index.js / index.ts in the folder and it will be executed with node.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { selectFromList } = require('./select');
const { t } = require('./i18n');

const STEPS_FILE = 'steps.json';

function normalizeSteps(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((step) => {
      if (typeof step === 'string') {
        return { name: step, folder: step };
      }
      if (step && typeof step === 'object') {
        const folder = step.folder || step.name;
        const name = step.name || step.folder;
        if (!folder || !name) return null;
        return { name, folder };
      }
      return null;
    })
    .filter(Boolean);
}

function loadSteps(projectDir) {
  const stepsPath = path.join(projectDir, STEPS_FILE);
  if (!fs.existsSync(stepsPath)) {
    throw new Error(t('stepsMissing'));
  }
  const data = JSON.parse(fs.readFileSync(stepsPath, 'utf8'));
  const steps = normalizeSteps(data && data.steps);
  if (steps.length === 0) {
    throw new Error(t('stepsEmpty'));
  }
  return steps;
}

function runCommand(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(t('exitCode', { cmd, code })));
    });
  });
}

function pickRunner(stepDir) {
  for (const name of ['index.js', 'index.mjs', 'index.ts']) {
    const candidate = path.join(stepDir, name);
    if (fs.existsSync(candidate)) {
      if (name.endsWith('.ts')) {
        return { cmd: 'npx', args: ['ts-node', candidate] };
      }
      return { cmd: 'node', args: [candidate] };
    }
  }
  // Default: let Playwright pick up spec files inside the step folder.
  return { cmd: 'npx', args: ['playwright', 'test', stepDir] };
}

async function invoke(projectDir) {
  const steps = loadSteps(projectDir);

  const labels = steps.map((s) => s.name);
  const chosenLabel = await selectFromList(t('chooseStep'), labels);
  if (!chosenLabel) {
    console.error(t('cancelled'));
    return;
  }

  const step = steps[labels.indexOf(chosenLabel)];
  const stepDir = path.join(projectDir, step.folder);
  if (!fs.existsSync(stepDir)) {
    throw new Error(t('folderNotExist', { dir: stepDir }));
  }

  const { cmd, args } = pickRunner(stepDir);
  console.log(t('running', { cmd: cmd + ' ' + args.join(' ') }));
  await runCommand(cmd, args, projectDir);
}

module.exports = { invoke, loadSteps, normalizeSteps };
