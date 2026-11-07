// Browser wiring. No matching, no formatting of findings: this file moves text
// that check.js produced into nodes, and owns the states in page-copy.md §6.
//
// Every reader-facing string here comes from launch/page-copy.md. If a string
// in this file is not in that document, it is a bug in this file.

import { checkPasted, checkRepo, CheckFailure } from './check.js';
import { checkDemo } from './demo.js';
import { parseRepoInput, looksLikeYaml } from './github.js';
import { VERSION } from './vendor/core/analyze.js';

const ERROR_COPY = {
  'no-config': 'This repo has no .github/dependabot.yml. Nothing to check.',
  private: 'We can only read public repos. Private repos need the CLI.',
  refused: 'GitHub refused the request (429 or private repo). Try again in a minute, or paste your YAML.',
  offline: 'GitHub refused the request (429 or private repo). Try again in a minute, or paste your YAML.',
  'too-large': "That manifest is too large to read in a browser (>1 MB). Paste your YAML, or use the CLI — we won't half-read a lockfile.",
  'bad-input': 'Enter a repository as owner/repo, or paste your YAML.',
};

const LISTING_BEFORE =
  'This config uses a directory glob, so the file list takes one call to api.github.com. Everything else is read from raw.githubusercontent.com.';
const LISTING_FAILED =
  "GitHub's anonymous API quota is used up for this network, so we can't list that directory. It resets hourly — or paste your YAML and we'll check the structure here.";
const LISTING_TRUNCATED =
  'That repository is too large for one file listing, so directory and ecosystem checks were skipped. The group checks below did run.';

const node = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
};

const ui = {};
let controller = null;

function init() {
  for (const id of ['repo-form', 'repo', 'check', 'paste-link', 'paste-panel', 'config', 'paste-check', 'demo', 'banner', 'result', 'status']) {
    ui[id] = document.getElementById(id);
  }

  ui['repo-form'].addEventListener('submit', (event) => {
    event.preventDefault();
    const value = ui.repo.value;
    // A visitor whose first move is to paste the file into the one field we
    // offer should get an answer, not a validation error.
    if (looksLikeYaml(value)) {
      void runPaste(value);
      return;
    }
    void runRepo(value);
  });

  ui['paste-link'].addEventListener('click', (event) => {
    event.preventDefault();
    openPaste();
  });

  ui['paste-panel'].addEventListener('submit', (event) => {
    event.preventDefault();
    void runPaste(ui.config.value);
  });

  ui.demo.addEventListener('click', (event) => {
    event.preventDefault();
    void runDemo();
  });
}

function openPaste() {
  ui['paste-panel'].hidden = false;
  ui['paste-link'].setAttribute('aria-expanded', 'true');
  ui.config.focus();
}

function setBusy(busy, message = '') {
  ui.check.disabled = busy;
  ui['paste-check'].disabled = busy;
  ui.demo.disabled = busy;
  ui.status.textContent = message;
  ui['repo-form'].setAttribute('aria-busy', busy ? 'true' : 'false');
}

function clearResult() {
  ui.result.replaceChildren();
  ui.banner.hidden = true;
  ui.banner.replaceChildren();
}

function showBanner(text) {
  ui.banner.replaceChildren(node('p', null, text));
  ui.banner.hidden = false;
}

function fail(kind) {
  const text = ERROR_COPY[kind] ?? ERROR_COPY.refused;
  ui.result.replaceChildren(node('p', 'message', text));
}

function render(report) {
  const container = document.createDocumentFragment();

  for (const line of report.verdict) container.appendChild(node('p', 'verdict', line));
  if (report.count) container.appendChild(node('p', 'count', report.count));

  if (report.detail && report.detail.length > 0) {
    container.appendChild(node('pre', 'detail', report.detail.join('\n')));
  }

  if (report.clean) container.appendChild(node('p', 'clean', report.clean));
  if (report.read) container.appendChild(node('p', 'read-set', report.read));

  if (report.findings) {
    const pre = node('pre', 'findings', report.findings);
    pre.setAttribute('tabindex', '0');
    pre.setAttribute('aria-label', 'findings');
    container.appendChild(pre);
  }

  if (report.skips && report.skips.length > 0) {
    container.appendChild(node('h2', 'skips-title', 'Not checked'));
    container.appendChild(node('pre', 'skips', report.skips.join('\n')));
  }

  ui.result.replaceChildren(container);
}

function start() {
  if (controller) controller.abort();
  controller = new AbortController();
  return controller.signal;
}

async function runRepo(input) {
  const parsed = parseRepoInput(input);
  if (!parsed) {
    clearResult();
    fail('bad-input');
    return;
  }

  const signal = start();
  clearResult();
  setBusy(true, `Reading ${parsed.owner}/${parsed.repo}…`);

  const hooks = {
    announce(event) {
      if (event && event.kind === 'listing-before') showBanner(LISTING_BEFORE);
    },
    notice(event) {
      if (!event) return;
      if (event.kind === 'listing-failed') showBanner(LISTING_FAILED);
      if (event.kind === 'listing-truncated') showBanner(LISTING_TRUNCATED);
      if (event.kind === 'capped') showBanner(LISTING_TRUNCATED);
    },
  };

  try {
    const { report } = await checkRepo({ owner: parsed.owner, repo: parsed.repo, hooks, signal });
    render(report);
    setBusy(false, '');
  } catch (error) {
    if (error && error.name === 'AbortError') return;
    clearResult();
    fail(error instanceof CheckFailure ? error.kind : 'refused');
    setBusy(false, '');
  }
}

async function runPaste(text) {
  const value = String(text ?? '');
  if (value.trim() === '') {
    clearResult();
    fail('bad-input');
    return;
  }
  start();
  clearResult();
  setBusy(true, '');
  try {
    const { report } = checkPasted(value);
    render(report);
  } catch (error) {
    clearResult();
    fail(error instanceof CheckFailure ? error.kind : 'refused');
  } finally {
    setBusy(false, '');
  }
}

async function runDemo() {
  const signal = start();
  clearResult();
  setBusy(true, 'Running the example…');
  try {
    const { report, notice } = await checkDemo({ signal });
    if (notice) showBanner(notice);
    render(report);
  } catch (error) {
    if (error && error.name === 'AbortError') return;
    clearResult();
    fail(error instanceof CheckFailure ? error.kind : 'refused');
  } finally {
    setBusy(false, '');
  }
}

function stampVersion() {
  const slot = document.getElementById('doc-version');
  if (slot) slot.textContent = VERSION;
}

init();
stampVersion();
