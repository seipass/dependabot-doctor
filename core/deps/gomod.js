// Go modules: go.mod (direct + indirect requires) and go.sum (full tree).
//
// Dependabot's gomod ecosystem reads both, so go.sum presence is what makes the
// dependency set complete.

export function collectGomod(ctx, directory) {
  const deps = [];
  const sources = [];
  const goMod = ctx.readIn(directory, 'go.mod');
  if (goMod == null) {
    return { ok: false, reason: `no go.mod in ${directory}` };
  }
  sources.push(ctx.relIn(directory, 'go.mod'));
  const direct = new Set();
  for (const entry of parseGoMod(goMod)) {
    direct.add(entry.name);
    deps.push({ name: entry.name, type: 'production', direct: !entry.indirect, source: 'go.mod' });
  }

  const goSum = ctx.readIn(directory, 'go.sum');
  let complete = false;
  if (goSum != null) {
    sources.push(ctx.relIn(directory, 'go.sum'));
    for (const name of parseGoSum(goSum)) {
      deps.push({ name, type: 'production', direct: direct.has(name), source: 'go.sum' });
    }
    complete = true;
  }

  return {
    ok: true,
    coverage: complete ? 'complete' : 'partial',
    reason: complete ? null : 'no go.sum committed; transitive modules are not enumerable offline',
    deps,
    sources,
  };
}

/** @returns {{name: string, version: string, indirect: boolean}[]} */
export function parseGoMod(text) {
  const out = [];
  let inRequire = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\/\/.*$/, '').trim();
    if (line === '') continue;
    if (line.startsWith('require (')) {
      inRequire = true;
      continue;
    }
    if (inRequire && line === ')') {
      inRequire = false;
      continue;
    }
    const indirect = /\/\/\s*indirect/.test(rawLine);
    const match = inRequire ? /^(\S+)\s+(v\S+)$/.exec(line) : /^require\s+(\S+)\s+(v\S+)$/.exec(line);
    if (match) out.push({ name: match[1], version: match[2], indirect });
  }
  return out;
}

export function parseGoSum(text) {
  const names = new Set();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    const parts = line.split(/\s+/);
    if (parts.length >= 2) names.add(parts[0]);
  }
  return names;
}
