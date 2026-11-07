// Cargo: Cargo.toml manifests + Cargo.lock.
//
// Without a committed Cargo.lock (normal for libraries) the resolved set is not
// enumerable offline, so coverage is partial and name-based findings are
// suppressed.

import { addDep } from './util.js';
import { parseToml } from '../toml.js';

const MANIFEST = 'Cargo.toml';
const LOCK = 'Cargo.lock';

const TYPE_SECTIONS = [
  ['dependencies', 'production'],
  ['dev-dependencies', 'development'],
  ['build-dependencies', 'production'],
];

export function collectCargo(ctx, directory) {
  const deps = new Map();
  const sources = [];
  const notes = [];

  const manifestText = ctx.readIn(directory, MANIFEST);
  if (manifestText == null) return { ok: false, reason: `no Cargo.toml in ${directory}` };
  sources.push(ctx.relIn(directory, MANIFEST));

  let data = null;
  try {
    data = parseToml(manifestText);
  } catch (error) {
    notes.push(`Cargo.toml: ${error.message}`);
  }
  if (data) {
    for (const { name, type } of cargoDependencies(data)) {
      addDep(deps, name, { type, direct: true, source: MANIFEST });
    }
  }

  let lockParsed = false;
  const lockNotes = [];
  const lockText = ctx.readAt(directory, LOCK);
  if (lockText != null) {
    sources.push(ctx.relAt(directory, LOCK));
    try {
      for (const name of parseCargoLock(lockText)) {
        addDep(deps, name, { source: LOCK });
      }
      lockParsed = true;
    } catch (error) {
      lockNotes.push(`Cargo.lock: ${error.message}`);
    }
  }

  if (!lockParsed) {
    return {
      ok: false,
      partial: true,
      deps,
      sources,
      reason: lockNotes.length
        ? `Cargo.lock not understood (${lockNotes.join('; ')})`
        : 'no Cargo.lock committed; transitive crates are not enumerable offline',
    };
  }
  return { ok: true, coverage: 'complete', deps, sources, notes };
}

/** Dependency names + types from a parsed Cargo.toml (incl. targets/workspace). */
export function cargoDependencies(data) {
  const out = [];
  const collect = (block, type) => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) return;
    for (const name of Object.keys(block)) out.push({ name, type });
  };
  for (const [section, type] of TYPE_SECTIONS) collect(data[section], type);
  const workspace = data.workspace;
  if (workspace && typeof workspace === 'object') collect(workspace.dependencies, 'production');
  const target = data.target;
  if (target && typeof target === 'object') {
    for (const cfg of Object.values(target)) {
      if (!cfg || typeof cfg !== 'object') continue;
      for (const [section, type] of TYPE_SECTIONS) collect(cfg[section], type);
    }
  }
  return out;
}

/** Cargo.lock `[[package]] name = "x"`. */
export function parseCargoLock(text) {
  const data = parseToml(text);
  const packages = data.package;
  if (!Array.isArray(packages)) throw new Error('no [[package]] tables');
  const names = [];
  for (const entry of packages) {
    if (entry && typeof entry.name === 'string') names.push(entry.name);
  }
  if (names.length === 0) throw new Error('no package names');
  return names;
}
