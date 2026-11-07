// Entry-level dependency enumeration: pick the collector for the declared
// ecosystem, run it against every directory the entry resolves to, and merge.

import { collectNpm } from './npm.js';
import { collectPython } from './python.js';
import { collectGomod } from './gomod.js';
import { collectCargo } from './cargo.js';
import { collectDocker } from './docker.js';
import { collectActions } from './actions.js';
import { pep503 } from './util.js';

const COLLECTORS = {
  npm: (ctx, directory) => collectNpm(ctx, directory),
  pip: (ctx, directory) => collectPython(ctx, directory, 'pip'),
  uv: (ctx, directory) => collectPython(ctx, directory, 'uv'),
  gomod: (ctx, directory) => collectGomod(ctx, directory),
  cargo: (ctx, directory) => collectCargo(ctx, directory),
  docker: (ctx, directory) => collectDocker(ctx, directory),
  'github-actions': (ctx, directory) => collectActions(ctx, directory),
};

/** Ecosystems whose dependency set we can enumerate offline in v1. */
export const ENUMERABLE = Object.keys(COLLECTORS);

/**
 * Build the read-only repo view shared by every collector.
 *
 * Pure by design: the caller supplies the file list and a `read(path)`
 * function. The CLI backs it with node:fs; the web page backs it with the
 * GitHub trees API plus raw.githubusercontent.com. Nothing in core/ imports a
 * Node builtin.
 *
 * @param {{directories: string[], filePaths: string[], read: (path: string) => string|null}} view
 */
export function createContext(view) {
  const filePaths = [...view.filePaths].sort();
  const directories = view.directories ?? deriveDirectories(filePaths);
  const underCache = new Map();
  const inCache = new Map();
  const readLog = new Set();

  const ctx = {
    root: view.root ?? '.',
    /** every file, repo-relative, no leading slash */
    filePaths,
    /** same list with a leading slash, for pattern matching against "/a/b" */
    slashPaths: filePaths.map((path) => `/${path}`),
    /** every directory in the checkout, normalized with a leading slash */
    directories,
    /** every repo file this analysis actually opened, in read order */
    readLog,
    read(relativePath) {
      const text = view.read(relativePath) ?? null;
      if (text != null) readLog.add(String(relativePath).replace(/^\//, ''));
      return text;
    },
    readIn(directory, name) {
      return ctx.read(ctx.relIn(directory, name));
    },
    readAt(directory, relativePath) {
      return ctx.read(ctx.relAt(directory, relativePath));
    },
    relIn(directory, name) {
      return directory === '/' ? name : `${directory.slice(1)}/${name}`;
    },
    relAt(directory, relativePath) {
      return directory === '/' ? relativePath : `${directory.slice(1)}/${relativePath}`;
    },
    /** basenames of the files directly inside a directory */
    filesIn(directory) {
      if (!inCache.has(directory)) {
        const prefix = directory === '/' ? '' : `${directory.slice(1)}/`;
        const names = new Set();
        for (const path of filePaths) {
          if (directory !== '/' && !path.startsWith(prefix)) continue;
          const rest = directory === '/' ? path : path.slice(prefix.length);
          if (!rest.includes('/')) names.add(rest);
        }
        inCache.set(directory, names);
      }
      return inCache.get(directory);
    },
    /** every file at or below a directory */
    filesUnder(directory) {
      if (!underCache.has(directory)) {
        const prefix = directory === '/' ? '' : `${directory.slice(1)}/`;
        underCache.set(directory, prefix === '' ? filePaths : filePaths.filter((path) => path.startsWith(prefix)));
      }
      return underCache.get(directory);
    },
    hasDirectory(directory) {
      return directories.includes(directory);
    },
  };
  return ctx;
}

/** Derive the directory list from file paths (used by the browser view). */
export function deriveDirectories(filePaths) {
  const set = new Set(['/']);
  for (const path of filePaths) {
    const segments = path.split('/');
    for (let i = 1; i < segments.length; i += 1) set.add(`/${segments.slice(0, i).join('/')}`);
  }
  return [...set].sort();
}

/**
 * Collect and merge the dependency set for one dependabot.yml entry.
 *
 * @returns {{
 *   supported: boolean,
 *   complete: boolean,
 *   reason: string|null,
 *   directories: {path: string, coverage: string, reason: string|null, sources: string[], deps: Map}[],
 *   deps: Map,
 *   sources: string[]
 * }}
 */
export function collectForEntry(ctx, entry, directories) {
  const collector = COLLECTORS[entry.ecosystem];
  if (!collector) {
    return {
      supported: false,
      complete: false,
      reason: `${entry.ecosystem} dependency files are not enumerable by this tool (supported: ${ENUMERABLE.join(', ')})`,
      directories: [],
      deps: new Map(),
      sources: [],
    };
  }

  const normalize = entry.ecosystem === 'pip' || entry.ecosystem === 'uv' ? pep503 : (name) => name;
  const results = [];
  const merged = new Map();
  const sources = new Set();
  const reasons = [];

  for (const directory of directories) {
    const result = collector(ctx, directory);
    results.push({
      path: directory,
      coverage: result.ok ? result.coverage : result.partial ? 'partial' : 'none',
      reason: result.reason ?? null,
      sources: result.sources ?? [],
      deps: result.deps ?? new Map(),
    });
    for (const source of result.sources ?? []) sources.add(source);
    if (result.reason) reasons.push(`${directory}: ${result.reason}`);
    const deps = result.deps instanceof Map ? result.deps : toMap(result.deps ?? []);
    for (const dep of deps.values()) {
      mergeDep(merged, dep, normalize);
    }
  }

  const complete = results.length > 0 && results.every((result) => result.coverage === 'complete');
  return {
    supported: true,
    complete,
    reason: complete ? null : reasons.join('; ') || 'dependency set incomplete',
    directories: results,
    deps: merged,
    sources: [...sources],
  };
}

function toMap(list) {
  const map = new Map();
  for (const dep of list) {
    const key = dep.name.toLowerCase();
    if (!map.has(key)) map.set(key, { name: dep.name, normalized: dep.name, type: dep.type ?? 'unknown', direct: Boolean(dep.direct), sources: dep.source ? [dep.source] : [] });
  }
  return map;
}

function mergeDep(merged, dep, normalize) {
  const key = dep.name.toLowerCase();
  const existing = merged.get(key);
  if (!existing) {
    merged.set(key, {
      name: dep.name,
      normalized: dep.normalized ?? normalize(dep.name),
      type: dep.type ?? 'unknown',
      direct: Boolean(dep.direct),
      sources: dep.sources ? [...dep.sources] : [],
    });
    return;
  }
  existing.direct = existing.direct || Boolean(dep.direct);
  if (existing.type !== dep.type) {
    if (existing.type === 'unknown') existing.type = dep.type;
    else if (dep.type !== 'unknown') existing.type = 'unknown';
  }
  for (const source of dep.sources ?? []) {
    if (!existing.sources.includes(source)) existing.sources.push(source);
  }
}
