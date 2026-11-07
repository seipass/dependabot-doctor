// Suggested dependabot.yml change, printed as a unified diff.
//
// This module builds a string. Nothing in this package writes to disk - the
// patch is stdout only, by design: a linter that edits the file it is judging
// cannot be re-run to confirm the fix.

const FIXABLE = new Set(['no-op-group', 'ignore-no-match']);
const CONTEXT = 3;

/**
 * @param {string} source original dependabot.yml text
 * @param {object[]} defects defects with a `_loc` range
 * @param {string} file display path
 */
export function buildPatch(source, defects, file = '.github/dependabot.yml') {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const removals = [];
  for (const defect of defects) {
    if (!FIXABLE.has(defect.code) || !defect._loc) continue;
    const loc = defect._loc;
    let start = loc.start;
    let end = loc.end;
    const onlyChild =
      (defect.code === 'no-op-group' && loc.groupCount === 1) ||
      (defect.code === 'ignore-no-match' && loc.itemCount === 1);
    if (onlyChild && loc.parentStart) {
      start = loc.parentStart;
      end = loc.parentEnd;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    removals.push({ start, end, defect });
  }
  if (removals.length === 0) return null;

  removals.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const removal of removals) {
    const last = merged[merged.length - 1];
    if (last && removal.start <= last.end + 1) {
      last.end = Math.max(last.end, removal.end);
      last.defects.push(removal.defect);
    } else {
      merged.push({ start: removal.start, end: removal.end, defects: [removal.defect] });
    }
  }

  const out = [`--- a/${file}`, `+++ b/${file}`, '# printed only - dependabot-doctor never writes files'];
  let removedSoFar = 0;
  for (const hunk of merged) {
    const contextStart = Math.max(1, hunk.start - CONTEXT);
    const contextEnd = Math.min(lines.length, hunk.end + CONTEXT);
    const oldCount = contextEnd - contextStart + 1;
    const newCount = oldCount - (hunk.end - hunk.start + 1);
    const newStart = contextStart - removedSoFar;
    out.push(`@@ -${contextStart},${oldCount} +${newStart},${newCount} @@`);
    for (let line = contextStart; line <= contextEnd; line += 1) {
      const text = lines[line - 1] ?? '';
      if (line >= hunk.start && line <= hunk.end) out.push(`-${text}`);
      else out.push(` ${text}`);
    }
    removedSoFar += hunk.end - hunk.start + 1;
  }
  return out.join('\n');
}
