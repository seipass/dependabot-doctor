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

  const verdict = dropUnverifiedClean(head, result);

  const findings = blocks
    .slice(1)
    .filter((block) => !block.startsWith('Not checked:'))
    .join('\n\n')
    .trim();

  const cleanState = isClean(verdict, result);

  return {
    kind: 'findings',
    // The clean sentence is the renderer's, verbatim (v0.1.4 prints page-copy
    // §4's first sentence itself). The page stopped composing it at that point:
    // a sentence the engine already produces is the definition of the drift this
    // page exists to avoid.
    verdict,
    // Its count line is suppressed in the clean state only because the same
    // sentence already ends "… against N manifests". Suppression may reduce
    // claims; it may not remove a fact, and no fact is lost here (a94).
    count: cleanState ? '' : countLine,
    // A verdict of "1 entry" above eight findings reads as an arithmetic error
    // unless the units are on screen. This counts the rows being rendered, not a
    // fact the engine owns, so it is allowed page-side (a92) — but only when
    // every row is a rule, when nothing is truncated, and when the numbers
    // actually differ. Otherwise no clause: silence beats a wrong noun.
    note: cleanState ? '' : ruleClause(result),
    findings,
    // A clean result is a result, not an absence: it names the files the check
    // actually opened, so "nothing found" cannot be mistaken for "nothing done".
    clean: cleanState ? CLEAN_PARAGRAPH : null,
    read: cleanState ? readLine(result) : '',
    skips: skipLines(result.skipped),
  };
}

const RULE_CODES = new Set(['ignore-no-match', 'no-op-group', 'captured-by-score']);

/** "8 rules across 1 entry", or nothing. */
function ruleClause(result) {
  const rows = Array.isArray(result.defects) ? result.defects.length : 0;
  const entries = result.summary?.entries ?? 0;
  if (entries === 0 || rows <= entries) return '';
  if (!result.defects.every((defect) => RULE_CODES.has(defect.code))) return '';
  return `${rows} rules across ${entries} ${entries === 1 ? 'entry' : 'entries'}`;
}

/**
 * page-copy.md §4, second sentence — the reassurance, and the only place on the
 * page a population number appears. 86% of visitors land in this state, so
 * "clean" has to read as a result rather than as an empty panel.
 */
const CLEAN_PARAGRAPH =
  'That is the normal result: of 234 real repositories we swept, 33 had any finding at all. What this cannot tell you is whether your entries fire on the next run — that depends on which updates are available, which we cannot see offline.';

/**
 * The engine's own clean verdict, i.e. every group was evaluated and matched.
 *
 * The positive test on the sentence is not enough on its own: the engine also
 * prints it when a dependency set could not be enumerated, and Toolsmith's rule
 * (a93) is that "We couldn't check {k} entries." is the verified/unverified
 * switch. So a clean state additionally requires that nothing was skipped for
 * want of a dependency set and that no group went unchecked — if either is
 * true, the reader gets the skip, never "nothing is dead".
 */
function isClean(verdict, result) {
  const sentence = verdict.some((line) => /^Nothing in your dependabot\.yml is dead\./.test(line));
  if (!sentence) return false;
  const skipped = result.skipped ?? [];
  if (skipped.some((item) => item.check === 'dependency-set')) return false;
  return uncheckableGroups(result) === 0;
}

/**
 * The read set, from the engine's own log — the files this check parsed, not the
 * files the repository has. Nothing here is a judgement; it is the answer to
 * "what did you actually look at?".
 */
function readLine(result) {
  const paths = ['.github/dependabot.yml', ...(result.files?.read_paths ?? [])];
  const files = result.files?.read ?? paths.length;
  const noun = files === 1 ? 'file' : 'files';
  if (paths.length === 0) return '';
  return `Read ${files} ${noun}: ${joinList(paths)}.`;
}

function joinList(items) {
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * "Nothing in your dependabot.yml is dead" is a claim about every entry. When a
 * group went unchecked it is not true, and a clean-looking
 * verdict is the most damaging thing this page could print — it reads as "you
 * may close the tab". The unchecked count is already in the verdict, so the
 * clean sentence is dropped rather than qualified: qualifying it would be new
 * copy, and page-copy.md owns those strings.
 */
function dropUnverifiedClean(lines, result) {
  if (uncheckableGroups(result) === 0) return lines;
  return lines.filter((line) => !/^Nothing in your dependabot\.yml is dead\./.test(line));
}

/** How many groups the engine could not evaluate (the set text.js counts). */
function uncheckableGroups(result) {
  return new Set(
    (result.skipped ?? []).filter((item) => item.check === 'no-op-group').map((item) => item.group ?? item.reason),
  ).size;
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

/**
 * Core prefixes a collector reason with its directory twice ("npm at /: /: no
 * lockfile committed …"), because collectForEntry adds the directory and
 * runChecks adds it again. The page prints the directory itself, so both are
 * removed here — this is presentation, not a correction of the engine.
 */
function stripPrefix(reason, ecosystem, directory) {
  let text = reason;
  if (ecosystem) {
    for (const prefix of [`${ecosystem} at ${directory}: `, `${ecosystem} at ${directory}, `]) {
      if (text.startsWith(prefix)) {
        text = text.slice(prefix.length);
        break;
      }
    }
  }
  const redundant = [`${directory}: `, `${directory}:`];
  for (const prefix of redundant) {
    if (text.startsWith(prefix)) {
      text = text.slice(prefix.length);
      break;
    }
  }
  return text;
}

export { renderText };
