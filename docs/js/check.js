// Orchestration: input -> repo view -> analyze() -> screen blocks.
//
// Two entry points, and the difference between them is only where the file
// bytes come from. The matcher and the renderer are the released core, mirrored
// byte-for-byte in docs/js/vendor/ (see tools/web/sync-vendor.mjs).
//
// Paste mode never touches the network, so it cannot fail for a network reason:
// it is the path that always answers, and it is the one the page falls back to.

import { analyze } from './vendor/core/analyze.js';
import { parseConfig } from './vendor/core/config.js';
import { buildReport } from './report.js';
import { buildView, reconcile } from './view.js';
import { planReads } from './probe-plan.js';
import { rawFile, fileList, stats } from './github.js';

export class CheckFailure extends Error {
  constructor(kind, detail = null) {
    super(kind);
    this.name = 'CheckFailure';
    this.kind = kind;
    this.detail = detail;
  }
}

const CONFIG_CANDIDATES = ['.github/dependabot.yml', '.github/dependabot.yaml'];
// Only used when no config was found, to tell "this repo has no config" from
// "we cannot see this repo at all". Both are 404 on raw, so one positive read
// of a file a public repository almost always has decides it.
const PRESENCE_MARKERS = ['README.md', 'README', 'readme.md', 'LICENSE', 'LICENSE.md'];
const MAX_PASTE_BYTES = 1024 * 1024;

/** Pure: text + a file map -> screen blocks. Used by paste mode and the demo. */
export function analyseText(configText, files, { listing = 'probe', file = '.github/dependabot.yml' } = {}) {
  const result = analyze({ configText, file, view: buildView(files) });
  return buildReport(reconcile(result, { listing }));
}

/** No network, no files: structural checks only, and it says so in the skips. */
export function checkPasted(configText) {
  const text = String(configText ?? '');
  if (bytes(text) > MAX_PASTE_BYTES) throw new CheckFailure('too-large');
  return { report: analyseText(text, new Map()), stats: { raw: 0, api: 0 } };
}

/**
 * @param {{owner: string, repo: string, hooks?: {announce?: Function, notice?: Function}, signal?: AbortSignal}} input
 */
export async function checkRepo({ owner, repo, hooks = {}, signal }) {
  const config = await fetchConfig({ owner, repo, signal });
  if (!config) {
    const visible = await anyMarker({ owner, repo, signal });
    throw new CheckFailure(visible ? 'no-config' : 'private');
  }

  // Parse once to learn what to read. A config our parser rejects is not a
  // reason to guess at its file list: analyze() reproduces the error verbatim,
  // with the blame on us.
  let entries = null;
  try {
    entries = parseConfig(config.text, config.path).entries;
  } catch {
    entries = null;
  }

  let listing = 'probe';
  let known = null;
  if (entries) {
    const first = planReads(entries);
    if (first.needsListing) {
      // Announced BEFORE the request, never disclosed after it. This ordering is
      // the mechanism behind the trust sentence, not a nicety (a92, a96).
      hooks.announce?.({
        kind: 'listing-before',
        owner,
        repo,
      });
      const tree = await fileList({ owner, repo, signal });
      if (tree.kind === 'ok' || tree.kind === 'truncated') {
        known = new Set(tree.paths);
        listing = tree.kind === 'ok' ? 'full' : 'partial';
        if (tree.kind === 'truncated') hooks.notice?.({ kind: 'listing-truncated' });
      } else {
        hooks.notice?.({ kind: 'listing-failed', reason: tree.kind });
      }
    }
  }

  const plan = entries ? planReads(entries, known) : { paths: [], capped: false };
  const { files, problems } = await fetchAll({ owner, repo, paths: plan.paths, signal });

  if (problems.length > 0) throw new CheckFailure('too-large', problems[0].path);
  if (plan.capped) hooks.notice?.({ kind: 'capped' });

  const report = analyseText(config.text, files, { listing, file: config.path });
  return { report, stats: { ...stats } };
}

async function fetchConfig({ owner, repo, signal }) {
  let refused = null;
  for (const path of CONFIG_CANDIDATES) {
    const result = await rawFile({ owner, repo, ref: 'HEAD', path, signal });
    if (result.kind === 'ok') return { path, text: result.text };
    if (result.kind === 'too-large') throw new CheckFailure('too-large', path);
    if (result.kind === 'refused' || result.kind === 'offline') refused = result.kind;
  }
  if (refused) throw new CheckFailure(refused);
  return null;
}

async function anyMarker({ owner, repo, signal }) {
  for (const path of PRESENCE_MARKERS) {
    const result = await rawFile({ owner, repo, ref: 'HEAD', path, signal });
    if (result.kind === 'ok') return true;
    if (result.kind === 'refused' || result.kind === 'offline') return false;
  }
  return false;
}

/** Small pool: enough to feel instant, small enough not to look like a burst. */
async function fetchAll({ owner, repo, paths, signal, concurrency = 4 }) {
  const files = new Map();
  const problems = [];
  let cursor = 0;

  const worker = async () => {
    while (cursor < paths.length) {
      const path = paths[cursor];
      cursor += 1;
      const result = await rawFile({ owner, repo, ref: 'HEAD', path, signal });
      if (result.kind === 'ok') files.set(path, result.text);
      else if (result.kind === 'too-large') problems.push({ path, kind: 'too-large' });
      else if (result.kind === 'refused' || result.kind === 'offline') {
        // A refusal is not evidence that a file is missing, so it stops the
        // check instead of producing a finding derived from absence.
        throw new CheckFailure(result.kind, path);
      }
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, Math.max(paths.length, 1)) }, () => worker());
  await Promise.all(workers);
  return { files, problems };
}

function bytes(text) {
  return typeof TextEncoder === 'undefined' ? text.length : new TextEncoder().encode(text).length;
}
