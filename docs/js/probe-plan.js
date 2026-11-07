// Which files to ask for, per ecosystem.
//
// A browser cannot list a directory: raw.githubusercontent.com serves files and
// never enumerates them. So the page can only see files whose names it can
// name itself — the manifests and lockfiles the config points at.
//
// Two consequences, both deliberate:
//
//   1. Every file name a collector in core/deps/*.js opens *by name* must
//      appear here. test/web-mirror.test.js scans that source and fails if one
//      is missing, so this table cannot silently fall behind the matcher.
//   2. Ecosystems whose collectors walk a directory (`filesIn`/`filesUnder`)
//      cannot be enumerated from probes. They are listed in LISTING_DEPENDENT,
//      and the page reports them as skipped rather than inferring absence from
//      a failed fetch. That is the same rule core/checks.js states in its own
//      header: anything we cannot prove is skipped, never reported as a defect.

import { deriveDirectories } from './vendor/core/deps/index.js';
import { expandDirectory } from './vendor/core/glob.js';
import { isManifestFile } from './vendor/core/manifests.js';

export const PROBE_FILES = {
  npm: ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml'],
  pip: [
    'pyproject.toml',
    'Pipfile',
    'Pipfile.lock',
    'poetry.lock',
    'uv.lock',
    'pdm.lock',
    'setup.py',
    'setup.cfg',
    'requirements.txt',
    'requirements-dev.txt',
    'requirements.in',
    'dev-requirements.txt',
    'constraints.txt',
    'constraints.in',
  ],
  uv: [
    'pyproject.toml',
    'Pipfile',
    'Pipfile.lock',
    'poetry.lock',
    'uv.lock',
    'pdm.lock',
    'setup.py',
    'setup.cfg',
    'requirements.txt',
    'requirements-dev.txt',
    'requirements.in',
    'dev-requirements.txt',
    'constraints.txt',
    'constraints.in',
  ],
  gomod: ['go.mod', 'go.sum'],
  cargo: ['Cargo.toml', 'Cargo.lock'],
  docker: ['Dockerfile', 'Containerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'],
  'github-actions': ['action.yml', 'action.yaml'],
};

/**
 * Ecosystems whose dependency set is discovered by listing a directory.
 *
 * Probes can find their *conventional* files, but a collector walking the tree
 * can also read files a probe list will never guess (`requirements-prod.txt`,
 * `Dockerfile.ci`, `.github/workflows/deploy.yml`). Absence is therefore not
 * provable from probes for these, and a "no manifest here" conclusion would be
 * an inference from a failed fetch — the one thing that must never ship.
 */
export const LISTING_DEPENDENT = new Set(['github-actions', 'docker', 'docker-compose', 'pip', 'uv']);

/** A hard stop so one enormous repo cannot turn into hundreds of requests. */
export const MAX_PROBE_FILES = 48;

export function isGlobPattern(pattern) {
  return String(pattern).includes('*');
}

/** '/a/b' -> 'a/b', '' -> '', base name of a repo-relative path. */
export function joinRepoPath(directory, name) {
  const clean = String(directory).replace(/^\/+|\/+$/g, '');
  return clean === '' ? name : `${clean}/${name}`;
}

/**
 * Work out what the page needs to read, without fetching anything yet.
 *
 * @param {Array<{ecosystem: string, directories: string[]}>} entries parsed config entries
 * @param {Set<string>|null} knownPaths full file list, when a tree call has already been made
 * @returns {{paths: string[], needsListing: boolean, capped: boolean}}
 */
export function planReads(entries, knownPaths = null) {
  const paths = new Set();
  let needsListing = false;
  let capped = false;
  const known = knownPaths ? new Set(knownPaths) : null;
  // Directories are expanded with core's own glob matcher, against a directory
  // list derived by core, so "/packages/*" means the same thing here as it does
  // in the CLI.
  const allDirectories = known ? deriveDirectories([...known]) : [];

  for (const entry of entries) {
    const resolved = [];
    for (const pattern of entry.directories ?? ['/']) {
      if (known) {
        resolved.push(...expandDirectory(pattern, allDirectories));
      } else if (isGlobPattern(pattern)) {
        // A glob cannot be expanded without a listing; the caller fetches one.
        needsListing = true;
      } else {
        resolved.push(pattern);
      }
    }

    for (const directory of resolved) {
      for (const name of PROBE_FILES[entry.ecosystem] ?? []) {
        const path = joinRepoPath(directory, name);
        if (!known || known.has(path)) paths.add(path);
      }
      if (known && LISTING_DEPENDENT.has(entry.ecosystem)) {
        // With a real file list, read what the collectors would read: every
        // path core's own detector calls a manifest for this ecosystem.
        for (const path of known) {
          if (paths.size >= MAX_PROBE_FILES) {
            capped = true;
            break;
          }
          if (isUnder(directory, path) && isManifestFile(entry.ecosystem, path)) paths.add(path);
        }
      }
    }
  }

  const limited = [...paths].slice(0, MAX_PROBE_FILES);
  if (limited.length < paths.size) capped = true;
  return { paths: limited, needsListing, capped };
}

function isUnder(directory, path) {
  const clean = String(directory).replace(/^\/+|\/+$/g, '');
  return clean === '' ? true : path === clean || path.startsWith(`${clean}/`);
}
