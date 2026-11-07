// GitHub Actions: `uses:` references in workflows and composite actions.
//
// A pinned action is a dependency of the `github-actions` ecosystem. We record
// two aliases per reference ("owner/repo" and the full path before `@`) so a
// pattern that uses either spelling still matches; extra aliases can only make
// us quieter, never produce a false "matches nothing".

const WORKFLOW_FILE = /\.ya?ml$/i;

export function collectActions(ctx, directory) {
  const workflowsDir = directory === '/' ? '/.github/workflows' : `${directory}/.github/workflows`;
  const sources = [];
  const refs = [];

  for (const name of ctx.filesIn(workflowsDir)) {
    if (!WORKFLOW_FILE.test(name)) continue;
    const relative = `${workflowsDir}/${name}`;
    const text = ctx.read(relative);
    if (text == null) continue;
    sources.push(relative);
    refs.push(...workflowUses(text));
  }

  for (const name of ['action.yml', 'action.yaml']) {
    const text = ctx.readIn(directory, name);
    if (text == null) continue;
    sources.push(ctx.relIn(directory, name));
    refs.push(...workflowUses(text));
  }

  if (sources.length === 0) {
    return { ok: false, reason: `no workflow files in ${workflowsDir}` };
  }

  const deps = [];
  for (const ref of refs) {
    for (const name of actionAliases(ref)) {
      deps.push({ name, type: 'production', direct: true, source: sources[0] });
    }
  }
  return { ok: true, coverage: 'complete', deps, sources, notes: [] };
}

/** Every `uses:` value in a workflow / action file. */
export function workflowUses(text) {
  const out = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '');
    const match = /^\s*(?:-\s*)?uses:\s*(.+)$/.exec(line);
    if (!match) continue;
    let value = match[1].trim();
    if (value.startsWith('"') || value.startsWith("'")) value = value.slice(1);
    if (value.endsWith('"') || value.endsWith("'")) value = value.slice(0, -1);
    value = value.trim();
    if (value === '' || value.includes('${{')) continue; // dynamic expression
    if (value.startsWith('./') || value.startsWith('../')) continue; // local action
    if (value.startsWith('docker://')) continue;
    if (!value.includes('@')) continue;
    out.push(value);
  }
  return out;
}

/** Aliases for a `uses:` reference: "owner/repo" and the full path. */
export function actionAliases(reference) {
  const withoutRef = reference.slice(0, reference.lastIndexOf('@'));
  if (withoutRef === '') return [];
  const segments = withoutRef.split('/');
  const aliases = new Set();
  if (segments.length >= 2) aliases.add(`${segments[0]}/${segments[1]}`);
  aliases.add(withoutRef);
  return [...aliases];
}
