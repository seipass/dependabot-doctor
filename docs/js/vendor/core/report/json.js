// JSON output — the machine contract.
//
// Stable shape (documented in README):
//   { version, root, file, entries, defects, skipped, warnings, errors, summary, files }
// Every defect carries: code, severity, ecosystem, directory, group, matched,
// why, yml_line, detail, evidence, suggestion.
// `code` is the durable identifier; the same value is mirrored as `kind` and
// `yml_line` is mirrored as `line` so older consumers keep working.

const HIDDEN = new Set(['_loc']);

export function serialize(result) {
  const payload = {
    version: result.version,
    root: result.root,
    file: result.file,
    ok: result.ok,
    entries: result.entries,
    defects: result.defects.map(clean),
    findings: result.defects.map(clean),
    skipped: result.skipped,
    warnings: result.warnings,
    errors: result.errors,
    summary: result.summary,
    files: result.files,
    events: undefined,
  };
  payload.exit = exitCodeFor(result, 'all');
  return payload;
}

export function clean(defect) {
  const out = {};
  for (const [key, value] of Object.entries(defect)) {
    if (HIDDEN.has(key)) continue;
    out[key] = value === undefined ? null : value;
  }
  out.kind = out.code;
  out.line = out.yml_line;
  return out;
}

/** Exit code: 1 for unusable config, 2 for defects matching failOn. */
export function exitCodeFor(result, failOn = 'all') {
  if (!result.ok) return 1;
  const codes = new Set(
    String(failOn)
      .split(',')
      .map((code) => code.trim())
      .filter(Boolean),
  );
  const matched = result.defects.filter((defect) => {
    if (codes.has('all')) return defect.severity !== 'info';
    if (codes.has(defect.code)) return true;
    if (codes.has(`${defect.code}:${defect.severity}`)) return true;
    return false;
  });
  return matched.length > 0 ? 2 : 0;
}
