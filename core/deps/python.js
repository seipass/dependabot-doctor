// Python dependency enumeration for `pip` and `uv`.
//
// Covered manifests: requirements*.txt / *.in, pyproject.toml (PEP 621 and
// poetry), Pipfile, setup.py, setup.cfg.
// Covered lockfiles: poetry.lock, uv.lock, pdm.lock, Pipfile.lock.
// Without a lockfile we only see the direct requirement set, which is not the
// universe dependabot resolves — so coverage is reported as partial and
// name-based findings are suppressed.

import { addDep, depSpecName, pep503 } from './util.js';
import { parseToml } from '../toml.js';

const LOCKFILES = ['poetry.lock', 'uv.lock', 'pdm.lock', 'Pipfile.lock'];
const REQUIREMENT_FILE = /^(?:requirements|reqs|constraints)[^/]*\.(?:txt|in)$/i;

export function collectPython(ctx, directory, ecosystem) {
  const deps = new Map();
  const sources = [];
  const notes = [];
  const normalize = pep503;

  // requirements files, including nested ones dependabot also fetches
  for (const relative of ctx.filesUnder(directory)) {
    const base = relative.slice(relative.lastIndexOf('/') + 1);
    if (!REQUIREMENT_FILE.test(base)) continue;
    const text = ctx.read(relative);
    if (text == null) continue;
    sources.push(relative);
    for (const name of parseRequirements(text)) {
      addDep(deps, name, { type: 'production', direct: true, source: relative, normalize });
    }
  }

  const pyproject = ctx.readIn(directory, 'pyproject.toml');
  if (pyproject != null) {
    sources.push(ctx.relIn(directory, 'pyproject.toml'));
    try {
      const data = parseToml(pyproject);
      for (const entry of pyprojectDependencies(data)) {
        addDep(deps, entry.name, { type: entry.type, direct: true, source: 'pyproject.toml', normalize });
      }
    } catch (error) {
      notes.push(`pyproject.toml: ${error.message}`);
    }
  }

  const pipfile = ctx.readIn(directory, 'Pipfile');
  if (pipfile != null) {
    sources.push(ctx.relIn(directory, 'Pipfile'));
    try {
      const data = parseToml(pipfile);
      for (const [section, type] of [
        ['packages', 'production'],
        ['dev-packages', 'development'],
      ]) {
        const block = data[section];
        if (!block || typeof block !== 'object') continue;
        for (const name of Object.keys(block)) {
          addDep(deps, name, { type, direct: true, source: 'Pipfile', normalize });
        }
      }
    } catch (error) {
      notes.push(`Pipfile: ${error.message}`);
    }
  }

  const setupPy = ctx.readIn(directory, 'setup.py');
  if (setupPy != null) {
    sources.push(ctx.relIn(directory, 'setup.py'));
    for (const name of parseSetupPy(setupPy)) {
      addDep(deps, name, { type: 'production', direct: true, source: 'setup.py', normalize });
    }
  }

  const setupCfg = ctx.readIn(directory, 'setup.cfg');
  if (setupCfg != null) {
    sources.push(ctx.relIn(directory, 'setup.cfg'));
    for (const name of parseSetupCfg(setupCfg)) {
      addDep(deps, name, { type: 'production', direct: true, source: 'setup.cfg', normalize });
    }
  }

  let lockParsed = false;
  const lockNotes = [];
  for (const file of LOCKFILES) {
    const text = ctx.readIn(directory, file);
    if (text == null) continue;
    sources.push(ctx.relIn(directory, file));
    try {
      for (const name of file === 'Pipfile.lock' ? parsePipfileLock(text) : parseTomlLock(text)) {
        addDep(deps, name, { source: file, normalize });
      }
      lockParsed = true;
    } catch (error) {
      lockNotes.push(`${file}: ${error.message}`);
    }
  }

  if (sources.length === 0) {
    return { ok: false, reason: `no python manifest in ${directory} (requirements*.txt, pyproject.toml, Pipfile, setup.py, setup.cfg)` };
  }
  if (!lockParsed) {
    return {
      ok: false,
      partial: true,
      deps,
      sources,
      reason: lockNotes.length
        ? `lockfile not understood (${lockNotes.join('; ')})`
        : 'no lockfile committed (poetry.lock, uv.lock, pdm.lock or Pipfile.lock)',
    };
  }
  return { ok: true, coverage: 'complete', deps, sources, notes };
}

/** Parse a pip requirements file into package names. */
export function parseRequirements(text) {
  const names = [];
  let buffer = '';
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine;
    const hash = line.indexOf(' #');
    if (hash >= 0) line = line.slice(0, hash);
    if (line.trimStart().startsWith('#')) continue;
    if (line.trimEnd().endsWith('\\')) {
      buffer += `${line.trimEnd().slice(0, -1)} `;
      continue;
    }
    line = `${buffer}${line}`;
    buffer = '';
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (/^(-r|-c|--requirement|--constraint|--index-url|--extra-index-url|-i|-f|--find-links|--trusted-host|--no-binary|--only-binary|--hash|-e|--editable|--pre|--no-deps)\b/.test(trimmed)) {
      if (/^(-e|--editable)\b/.test(trimmed)) {
        const name = depSpecName(trimmed.replace(/^(-e|--editable)\s*/, ''));
        if (name) names.push(name);
      }
      continue;
    }
    const name = depSpecName(trimmed);
    if (name) names.push(name);
  }
  return names;
}

/** Names + dependency types from a parsed pyproject.toml. */
export function pyprojectDependencies(data) {
  const out = [];
  const push = (name, type) => {
    const cleaned = depSpecName(name) ?? (typeof name === 'string' ? name : null);
    if (cleaned) out.push({ name: cleaned, type });
  };

  const project = data.project;
  if (project && typeof project === 'object') {
    for (const spec of asArray(project.dependencies)) push(spec, 'production');
    const optional = project['optional-dependencies'];
    if (optional && typeof optional === 'object') {
      for (const list of Object.values(optional)) {
        for (const spec of asArray(list)) push(spec, 'unknown');
      }
    }
  }

  const poetry = data.tool && data.tool.poetry;
  if (poetry && typeof poetry === 'object') {
    for (const name of Object.keys(poetry.dependencies || {})) {
      if (name.toLowerCase() === 'python') continue;
      push(name, 'production');
    }
    for (const name of Object.keys(poetry['dev-dependencies'] || {})) push(name, 'development');
    const groups = poetry.group;
    if (groups && typeof groups === 'object') {
      for (const group of Object.values(groups)) {
        if (!group || typeof group !== 'object') continue;
        for (const name of Object.keys(group.dependencies || {})) push(name, 'development');
      }
    }
  }

  const pdm = data.tool && data.tool.pdm;
  if (pdm && typeof pdm === 'object') {
    const dev = pdm['dev-dependencies'];
    if (dev && typeof dev === 'object') {
      for (const list of Object.values(dev)) {
        for (const spec of asArray(list)) push(spec, 'development');
      }
    }
  }
  return out;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return [value];
  return [];
}

export function parseSetupPy(text) {
  const names = [];
  const block = /install_requires\s*=\s*\[([\s\S]*?)\]/.exec(text);
  if (block) {
    for (const match of block[1].matchAll(/['"]([^'"]+)['"]/g)) {
      const name = depSpecName(match[1]);
      if (name) names.push(name);
    }
  }
  return names;
}

export function parseSetupCfg(text) {
  const names = [];
  const lines = text.split(/\r?\n/);
  let inRequirements = false;
  for (const line of lines) {
    if (/^install_requires\s*=/.test(line.trim())) {
      inRequirements = true;
      const rest = line.slice(line.indexOf('=') + 1).trim();
      if (rest) {
        const name = depSpecName(rest);
        if (name) names.push(name);
      }
      continue;
    }
    if (inRequirements) {
      if (line.trim() === '' || /^\S/.test(line)) {
        inRequirements = false;
        continue;
      }
      const name = depSpecName(line.trim());
      if (name) names.push(name);
    }
  }
  return names;
}

/** [[package]] name = "x" — poetry.lock, uv.lock, pdm.lock. */
export function parseTomlLock(text) {
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

export function parsePipfileLock(text) {
  const data = JSON.parse(text);
  const names = [];
  for (const section of ['default', 'develop']) {
    const block = data[section];
    if (!block || typeof block !== 'object') continue;
    for (const name of Object.keys(block)) names.push(name);
  }
  if (names.length === 0) throw new Error('no default/develop packages');
  return names;
}
