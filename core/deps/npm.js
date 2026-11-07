// npm / yarn / pnpm dependency enumeration.
//
// The dependency universe dependabot sees for `package-ecosystem: npm` is the
// union of the manifest and whatever lockfile is committed, including
// transitive packages — so a group pattern like "eslint*" can legitimately
// match a transitive-only name. We therefore only claim "complete" coverage
// when a lockfile was actually parsed; without one, findings that would require
// the transitive set are suppressed (see src/checks/*).

import { addDep } from './util.js';
import { parseYaml } from '../yaml.js';

const MANIFEST = 'package.json';
const LOCKFILES = [
  { file: 'package-lock.json', kind: 'npm' },
  { file: 'npm-shrinkwrap.json', kind: 'npm' },
  { file: 'yarn.lock', kind: 'yarn' },
  { file: 'pnpm-lock.yaml', kind: 'pnpm' },
];

export function collectNpm(ctx, directory) {
  const deps = new Map();
  const sources = [];
  const notes = [];
  const directTypes = new Map();

  const manifestText = ctx.readIn(directory, MANIFEST);
  if (manifestText != null) {
    sources.push(ctx.relIn(directory, MANIFEST));
    const manifest = safeJson(manifestText);
    if (!manifest) {
      notes.push('package.json could not be parsed as JSON');
    } else {
      const sections = [
        ['dependencies', 'production'],
        ['devDependencies', 'development'],
        ['optionalDependencies', 'production'],
        ['peerDependencies', 'production'],
      ];
      for (const [section, type] of sections) {
        const block = manifest[section];
        if (!block || typeof block !== 'object') continue;
        for (const name of Object.keys(block)) {
          directTypes.set(name.toLowerCase(), type);
          addDep(deps, name, { type, direct: true, source: MANIFEST });
        }
      }
    }
  }

  let lockParsed = false;
  const lockNotes = [];
  for (const { file, kind } of LOCKFILES) {
    const text = ctx.readIn(directory, file);
    if (text == null) continue;
    sources.push(ctx.relIn(directory, file));
    try {
      const names = kind === 'npm' ? parseNpmLock(text) : kind === 'yarn' ? parseYarnLock(text) : parsePnpmLock(text);
      for (const name of names) {
        addDep(deps, name, { source: file });
      }
      lockParsed = true;
    } catch (error) {
      lockNotes.push(`${file}: ${error.message}`);
    }
  }

  // Lockfile names are not marked direct by the parsers above; promote the ones
  // that appear in the manifest so dependency-type checks stay accurate.
  for (const dep of deps.values()) {
    const directType = directTypes.get(dep.name.toLowerCase());
    if (directType) {
      dep.direct = true;
      dep.type = directType;
    }
  }

  if (!manifestText && !lockParsed) {
    return { ok: false, reason: `no package.json, package-lock.json, yarn.lock or pnpm-lock.yaml in ${directory}` };
  }
  if (!lockParsed) {
    return {
      ok: false,
      reason: lockNotes.length
        ? `lockfile not understood (${lockNotes.join('; ')})`
        : 'no lockfile committed (package-lock.json, yarn.lock or pnpm-lock.yaml)',
      partial: true,
      deps,
      sources,
    };
  }
  return { ok: true, coverage: 'complete', deps, sources, notes };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** package-lock.json v1 (nested) and v2/v3 (flat `packages` map). */
export function parseNpmLock(text) {
  const data = safeJson(text);
  if (!data || typeof data !== 'object') throw new Error('not valid JSON');
  const names = new Set();
  if (data.packages && typeof data.packages === 'object') {
    for (const [key, value] of Object.entries(data.packages)) {
      if (key === '') continue;
      if (!key.includes('node_modules/')) continue; // workspace folder, not a package
      const name = packageNameFromPath(key) ?? (value && typeof value.name === 'string' ? value.name : null);
      if (name) names.add(name);
    }
    if (names.size > 0) return names;
  }
  const walk = (block) => {
    if (!block || typeof block !== 'object') return;
    for (const [name, value] of Object.entries(block)) {
      names.add(name);
      if (value && typeof value === 'object' && value.dependencies) walk(value.dependencies);
    }
  };
  walk(data.dependencies);
  if (names.size === 0) throw new Error('no packages found');
  return names;
}

function packageNameFromPath(path) {
  const index = path.lastIndexOf('node_modules/');
  if (index < 0) return null;
  return path.slice(index + 'node_modules/'.length);
}

/**
 * yarn.lock, both classic and berry.
 * Classic:  "lodash@^4.17.21", lodash@^4.17.20:
 * Berry:    "lodash@npm:^4.17.21":
 * Only top-level (unindented) keys are dependency descriptors.
 */
export function parseYarnLock(text) {
  const names = new Set();
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine === '' || rawLine[0] === ' ' || rawLine[0] === '\t' || rawLine[0] === '#') continue;
    if (!rawLine.endsWith(':')) continue;
    const header = rawLine.slice(0, -1).trim();
    if (header === '' || header.startsWith('__metadata')) continue;
    for (const descriptor of splitDescriptors(header)) {
      const name = packageNameFromDescriptor(descriptor);
      if (name) names.add(name);
    }
  }
  if (names.size === 0) throw new Error('no package descriptors found');
  return names;
}

function splitDescriptors(header) {
  const out = [];
  let current = '';
  let inQuotes = false;
  for (const ch of header) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
      continue;
    }
    if (ch === ',' && !inQuotes) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((part) => part.trim().replace(/^"|"$/g, '')).filter(Boolean);
}

/** "@scope/pkg@npm:^1.0.0" -> "@scope/pkg"; "pkg@^1.0.0" -> "pkg". */
export function packageNameFromDescriptor(descriptor) {
  if (descriptor.startsWith('__')) return null;
  if (descriptor.startsWith('@')) {
    const slash = descriptor.indexOf('/');
    if (slash < 0) return null;
    const at = descriptor.indexOf('@', slash);
    return at < 0 ? descriptor : descriptor.slice(0, at);
  }
  const at = descriptor.indexOf('@');
  return at <= 0 ? descriptor : descriptor.slice(0, at);
}

/**
 * pnpm-lock.yaml. We read the importer sections (direct deps) and the
 * packages/snapshots keys (full tree). v5 keys look like "/pkg/1.2.3" or
 * "/@scope/pkg/1.2.3"; v6/v9 keys look like "pkg@1.2.3" or
 * "@scope/pkg@1.2.3(react@18.0.0)".
 */
export function parsePnpmLock(text) {
  // A merged or concatenated lockfile (two documents, or the same top-level key
  // twice) parses into a truncated dependency set. Silently treating that as
  // "complete" would make every group look empty, so refuse it instead.
  const lineSeparator = new RegExp(String.fromCharCode(13) + '?' + String.fromCharCode(10));
  const versionLines = text.split(lineSeparator).filter((line) => /^lockfileVersion:/.test(line)).length;
  if (versionLines > 1) throw new Error(`${versionLines} lockfileVersion headers (concatenated lockfile?)`);
  const data = parseYaml(text);
  if (data.duplicateKeys && data.duplicateKeys.length > 0) {
    throw new Error(`duplicate top-level keys: ${data.duplicateKeys.join(', ')}`);
  }
  const names = new Set();
  const importerRoot = findKey(data, 'importers');
  if (importerRoot && importerRoot.type === 'map') {
    for (const importer of importerRoot.entries) {
      for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        const block = findKey(importer.value, section);
        if (block && block.type === 'map') {
          for (const dep of block.entries) names.add(dep.key);
        }
      }
    }
  }
  for (const section of ['packages', 'snapshots']) {
    const block = findKey(data, section);
    if (block && block.type === 'map') {
      for (const entry of block.entries) {
        const name = packageNameFromPnpmKey(entry.key);
        if (name) names.add(name);
      }
    }
  }
  if (names.size === 0) throw new Error('no package entries found');
  return names;
}

function findKey(node, key) {
  if (!node || node.type !== 'map') return undefined;
  const entry = node.entries.find((e) => e.key === key);
  return entry ? entry.value : undefined;
}

export function packageNameFromPnpmKey(key) {
  let text = String(key).trim();
  if (text === '') return null;
  text = text.replace(/^\//, '');
  const paren = text.indexOf('(');
  if (paren >= 0) text = text.slice(0, paren);
  if (text.startsWith('@')) {
    const slash = text.indexOf('/');
    if (slash < 0) return null;
    const afterScope = text.slice(slash + 1);
    if (afterScope.startsWith('@')) return null;
    const at = text.indexOf('@', slash);
    if (at > slash) return text.slice(0, at);
    const segments = text.split('/');
    if (segments.length >= 3) return segments.slice(0, 2).join('/');
    return text;
  }
  const at = text.indexOf('@');
  if (at > 0) return text.slice(0, at);
  const segments = text.split('/');
  if (segments.length >= 2) return segments[0];
  return text;
}
