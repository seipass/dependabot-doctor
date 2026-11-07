// Filesystem scanning: a cheap, bounded directory walk plus text reads.
//
// The tool only ever reads. Nothing in this package writes to the repository,
// and the suggested patch is printed to stdout (see report/patch.js).

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, posix, sep } from 'node:path';

const SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'bower_components',
  '.pnpm-store',
  '.venv',
  'venv',
  'env',
  '__pycache__',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.idea',
  '.vscode',
  '.gradle',
  '.m2',
  'dist',
  'build',
  'target',
  'vendor',
  'third_party',
  '.next',
  '.nuxt',
  '.cache',
  '.terraform',
  '.serverless',
  '.yarn',
]);

const MAX_FILES = 200000;
const MAX_DEPTH = 24;

/**
 * Walk a checkout and return the directories and files it contains.
 * @param {string} root absolute path
 */
export function scanTree(root) {
  /** @type {string[]} */
  const directories = [];
  /** @type {Map<string, Set<string>>} */
  const files = new Map();
  let fileCount = 0;
  let truncated = false;

  const visit = (absolute, relative, depth) => {
    if (truncated) return;
    if (depth > MAX_DEPTH) return;
    let names;
    try {
      names = readdirSync(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    const fileSet = new Set();
    files.set(relative, fileSet);
    directories.push(relative);
    for (const entry of names) {
      if (truncated) return;
      if (entry.isSymbolicLink()) continue;
      const childAbsolute = join(absolute, entry.name);
      const childRelative = relative === '/' ? `/${entry.name}` : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
        visit(childAbsolute, childRelative, depth + 1);
      } else if (entry.isFile()) {
        fileCount += 1;
        if (fileCount > MAX_FILES) {
          truncated = true;
          return;
        }
        fileSet.add(entry.name);
      }
    }
  };

  visit(root, '/', 0);
  return { directories, files, truncated };
}

/** Read a file as UTF-8, returning null when it is missing or unreadable. */
export function readText(root, relativePath) {
  const absolute = join(root, relativePath.replace(/^\//, '').split('/').join(sep));
  if (!existsSync(absolute)) return null;
  try {
    if (!statSync(absolute).isFile()) return null;
    return readFileSync(absolute, 'utf8');
  } catch {
    return null;
  }
}

/** True when the directory exists (used to distinguish "missing" from "empty"). */
export function isDirectory(root, relativePath) {
  const absolute = join(root, relativePath.replace(/^\//, '').split('/').join(sep));
  try {
    return statSync(absolute).isDirectory();
  } catch {
    return false;
  }
}

/** Join a directory and a file name into a repo-relative posix path. */
export function joinPath(directory, name) {
  return directory === '/' ? name : `${directory.slice(1)}/${name}`;
}

/** Parent directory of a repo-relative path. */
export function dirname(relativePath) {
  return posix.dirname(relativePath);
}
