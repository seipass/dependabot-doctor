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
 * Two reasons a claim has to go, and only two:
 *
 *   1. The check needs a directory listing (`directory-no-match`,
 *      `ecosystem-absent`) and probes cannot provide one.
 *   2. The entry's ecosystem is discovered by walking a directory. A collector
 *      that walks and finds nothing returns "complete, zero dependencies", and
 *      a zero-dependency set turns into "matched 0 of 0 direct dependencies" —
 *      which is a false finding on a repo whose workflows exist and were simply
 *      never listed. (Measured: seipass/dependabot-doctor read `action.yml`
 *      only, and the engine reported its `actions/*` group as matching
 *      nothing.) So the whole entry is uncheckable in probe mode, whatever the
 *      collector concluded.
 *
 * Everything dropped is replaced by an entry in the §5 skipped block and stays
 * counted in the verdict; nothing disappears quietly.
 *
 * @param {object} result analyze() output
 * @param {{listing: 'full'|'probe'|'partial'}} options
 */
export function reconcile(result, { listing = 'probe' } = {}) {
  if (!result.ok) return result;
  // A complete listing makes every check provable, so the engine's own output
  // is used untouched.
  if (listing === 'full') return result;

  const blocked = new Set();
  for (const entry of result.entries ?? []) {
    if (LISTING_DEPENDENT.has(entry.ecosystem)) blocked.add(key(entry.ecosystem, dirText(entry)));
  }

  const defects = [];
  for (const defect of result.defects) {
    if (LISTING_CODES.has(defect.code)) continue;
    if (blocked.has(key(defect.ecosystem, defect.directory))) continue;
    defects.push(defect);
  }

  const skipped = [];
  const uncheckable = new Map();
  const listingSkips = new Map();

  const noteListing = (ecosystem, directory) => {
    const id = key(ecosystem, directory);
    if (!listingSkips.has(id)) {
      listingSkips.set(id, { check: 'listing', ecosystem, directory, reason: PAGE_SKIP_REASON });
    }
    for (const group of groupsFor(result, ecosystem, directory)) {
      const groupKey = `${ecosystem}|${group}`;
      if (!uncheckable.has(groupKey)) {
        uncheckable.set(groupKey, { check: 'no-op-group', ecosystem, directory, group, reason: PAGE_SKIP_REASON });
      }
    }
  };

  for (const item of result.skipped) {
    if (item.check !== 'dependency-set') {
      skipped.push(item);
      continue;
    }
    if (LISTING_DEPENDENT.has(item.ecosystem)) {
      // Reason from the collector is not shown: it can say "no workflow files"
      // about a directory we never read.
      noteListing(item.ecosystem, item.directory);
      continue;
    }
    // Probe-provable and honest as printed: e.g. "no lockfile committed", which
    // is a statement about files we did fetch.
    skipped.push(item);
    for (const group of groupsFor(result, item.ecosystem, item.directory)) {
      const groupKey = `${item.ecosystem}|${group}`;
      if (!uncheckable.has(groupKey)) {
        uncheckable.set(groupKey, {
          check: 'no-op-group',
          ecosystem: item.ecosystem,
          directory: item.directory,
          group,
          reason: item.reason,
        });
      }
    }
  }

  for (const entry of result.entries ?? []) {
    if (LISTING_DEPENDENT.has(entry.ecosystem)) noteListing(entry.ecosystem, dirText(entry));
  }
  for (const defect of result.defects) {
    if (LISTING_CODES.has(defect.code)) noteListing(defect.ecosystem, defect.directory);
  }

  return {
    ...result,
    defects,
    summary: resummarise(result.summary, defects),
    skipped: [...skipped, ...uncheckable.values(), ...listingSkips.values()],
  };
}

/** Summary counts must describe the defects that survived, not the ones dropped. */
function resummarise(summary, defects) {
  const count = (code) => defects.filter((defect) => defect.code === code).length;
  return {
    ...summary,
    groups_empty: count('no-op-group'),
    ignores_unmatched: count('ignore-no-match'),
    directories_unmatched: count('directory-no-match'),
    ecosystems_absent: count('ecosystem-absent'),
    flood_risks: count('flood-risk'),
  };
}

function dirText(entry) {
  return Array.isArray(entry.directory) ? entry.directory.join(', ') : String(entry.directory ?? '/');
}

function key(ecosystem, directory) {
  return `${ecosystem}|${String(directory ?? '').replace(/\s+/g, ' ').trim()}`;
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
