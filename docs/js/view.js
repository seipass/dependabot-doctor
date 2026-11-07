// The repo view, and the one place the browser is allowed to be narrower than
// the CLI.
//
// `core/analyze.js` takes a view — {filePaths, directories, read(path)} — and
// knows nothing about where they came from. The CLI backs it with node:fs. Here
// it is backed by whatever raw.githubusercontent.com actually returned.
//
// The narrowing is real and has to be reported, not hidden: a browser cannot
// list a directory, so `directory-no-match` ("this path does not exist") and
// `ecosystem-absent` ("no manifest under this path") are not provable from
// probes. core/checks.js already commits to the same rule in its own header —
// anything we cannot prove is skipped, never reported as a defect — so this
// module applies it to the two codes the transport, not the matcher, limits.

import { deriveDirectories } from './vendor/core/deps/index.js';
import { LISTING_DEPENDENT } from './probe-plan.js';

/** Sanctioned by Strategy (a92) 2026-11-07, launch/page-copy.md §5. */
export const PAGE_SKIP_REASON =
  "we didn't read the repo's file list, so directory and ecosystem checks could not run.";

/** Codes that need a directory listing to be true. */
const LISTING_CODES = new Set(['directory-no-match', 'ecosystem-absent']);

/**
 * @param {Map<string, string>} files repo-relative path -> text
 */
export function buildView(files) {
  const filePaths = [...files.keys()].sort();
  return {
    root: '.',
    filePaths,
    directories: deriveDirectories(filePaths),
    read(path) {
      const key = String(path).replace(/^\/+/, '');
      const text = files.get(key);
      return text == null ? null : text;
    },
  };
}

/**
 * Drop claims the transport cannot support, and say so out loud.
 *
 * @param {object} result analyze() output
 * @param {{listing: 'full'|'probe'|'partial'}} options
 */
export function reconcile(result, { listing = 'probe' } = {}) {
  if (!result.ok) return result;
  // A complete listing makes every check provable, so the engine's own output
  // is used untouched.
  if (listing === 'full') return result;

  const defects = [];
  const dropped = [];
  for (const defect of result.defects) {
    if (LISTING_CODES.has(defect.code)) dropped.push(defect);
    else defects.push(defect);
  }

  const skipped = [];
  const uncheckable = new Map();
  const listingSkips = new Map();

  const noteListing = (ecosystem, directory) => {
    const key = `${ecosystem}|${directory}`;
    if (!listingSkips.has(key)) {
      listingSkips.set(key, { check: 'listing', ecosystem, directory, reason: PAGE_SKIP_REASON });
    }
    noteUncheckable(ecosystem, directory, PAGE_SKIP_REASON);
  };

  const noteUncheckable = (ecosystem, directory, reason) => {
    for (const group of groupsFor(result, ecosystem, directory)) {
      const key = `${ecosystem}|${group}`;
      if (!uncheckable.has(key)) uncheckable.set(key, { check: 'no-op-group', ecosystem, directory, group, reason });
    }
  };

  for (const item of result.skipped) {
    if (item.check !== 'dependency-set') {
      skipped.push(item);
      continue;
    }
    // A dependency set this page could not fully enumerate means the groups in
    // that entry were never evaluated. Saying nothing would let the verdict
    // imply we looked, so the groups are counted as unchecked.
    if (LISTING_DEPENDENT.has(item.ecosystem)) {
      noteListing(item.ecosystem, item.directory);
      continue;
    }
    // Probe-provable and honest as printed: e.g. "no lockfile committed", which
    // is a statement about files we did fetch.
    skipped.push(item);
    noteUncheckable(item.ecosystem, item.directory, item.reason);
  }

  for (const defect of dropped) noteListing(defect.ecosystem, defect.directory);

  return {
    ...result,
    defects,
    skipped: [...skipped, ...uncheckable.values(), ...listingSkips.values()],
  };
}

/** Group names of the entries a skip line refers to. */
function groupsFor(result, ecosystem, directoryText) {
  const out = [];
  const wanted = String(directoryText ?? '').split(',').map((part) => part.trim());
  for (const entry of result.entries ?? []) {
    if (entry.ecosystem !== ecosystem) continue;
    const dirs = Array.isArray(entry.directory) ? entry.directory : [entry.directory];
    if (!dirs.some((dir) => wanted.includes(String(dir)))) continue;
    for (const group of entry.groups ?? []) out.push(group);
  }
  return out;
}
