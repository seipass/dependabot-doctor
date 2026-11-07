// Turning analyze() output into screen blocks.
//
// The finding text is NOT written here. It comes from core/report/text.js —
// the same function the CLI prints — so the page and the CLI cannot drift: the
// verdict, the 26-column label, the line reference and the 78-column detail
// wrap are all the renderer's, not this file's.
//
// This module only decides what becomes a heading, what becomes the count line,
// and what the skipped block looks like (page-copy.md §2, §5).

import { renderText } from './vendor/core/report/text.js';

const READ_COUNT = /\s*Read \d+ files?\.?/;

/**
 * @param {object} result analyze() output
 * @returns {{
 *   kind: 'findings'|'unreadable',
 *   verdict: string[],
 *   count: string,
 *   findings: string,
 *   skips: string[],
 *   detail?: string[]
 * }}
 */
export function buildReport(result) {
  if (!result.ok) return buildUnreadable(result);

  const text = renderText(result);
  const blocks = text.split('\n\n');

  // Block 0 is always verdict sentences + the count line, with no blank line
  // between them (text.js pushes verdictLines then checkedLine).
  const head = (blocks[0] ?? '').split('\n').filter((line) => line !== '');
  const count = head.length > 0 && /^Checked\b/.test(head[head.length - 1]) ? head.pop() : '';

  // "Read N files." is off public strings for now (Outreach a94, recorded in
  // scripts/check-demo-frozen.sh) while the CLI still prints it; the number the
  // page keeps is the manifest count, and it is derived from the fetch list.
  const countLine = count.replace(READ_COUNT, '').trim();

  const findings = blocks
    .slice(1)
    .filter((block) => !block.startsWith('Not checked:'))
    .join('\n\n')
    .trim();

  return {
    kind: 'findings',
    verdict: head,
    count: countLine,
    findings,
    skips: skipLines(result.skipped),
  };
}

/**
 * A file this tool could not read is a statement about us first.
 * The page may never claim the visitor's YAML is invalid: only a real YAML
 * library's own verdict could justify that, and our parser is the only parser
 * in the browser (page-copy.md §6).
 */
function buildUnreadable(result) {
  const errors = Array.isArray(result.errors) ? result.errors : [];
  const at = errors.find((error) => error && error.line);
  const where = at && at.line ? ` (line ${at.line})` : '';
  const parserProblem = errors.some((error) => error && (error.kind === 'invalid-yaml' || error.kind === 'unsupported-yaml'));
  const lead = parserProblem
    ? `We couldn't read this file${where}. That's our parser, not necessarily your config.`
    : `We couldn't read this file as a dependabot.yml${where}. That's our reading of it, not necessarily your config.`;
  const detail = errors
    .filter(Boolean)
    .map((error) => (error.line ? `line ${error.line}: ${error.message}` : String(error.message ?? '')))
    .filter(Boolean);

  return { kind: 'unreadable', verdict: [lead], count: '', findings: '', skips: [], detail };
}

/**
 * §5 layout: `<dir> (<ecosystem>): skipped — <reason>.` then one "We don't
 * guess." line. Every skipped item is shown; none is folded away.
 */
function skipLines(skipped) {
  if (!Array.isArray(skipped) || skipped.length === 0) return [];
  const seen = new Set();
  const lines = [];
  for (const item of skipped) {
    const directory = String(item.directory ?? '/').trim() || '/';
    const ecosystem = item.ecosystem ? ` (${item.ecosystem})` : '';
    const reason = stripPrefix(String(item.reason ?? '').trim(), item.ecosystem, directory).replace(/\.\s*$/, '');
    if (reason === '') continue;
    const line = `${directory}${ecosystem}: skipped — ${reason}.`;
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  if (lines.length > 0) lines.push("We don't guess.");
  return lines;
}

/** "npm at /: no lockfile committed" -> "no lockfile committed" */
function stripPrefix(reason, ecosystem, directory) {
  if (!ecosystem) return reason;
  const prefixes = [`${ecosystem} at ${directory}: `, `${ecosystem} at ${directory}, `];
  for (const prefix of prefixes) {
    if (reason.startsWith(prefix)) return reason.slice(prefix.length);
  }
  return reason;
}

export { renderText };
