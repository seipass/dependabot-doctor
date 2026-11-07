// Human-readable report.
//
// The layout is not cosmetic: `launch/page-copy.md` freezes the demo output and
// `scripts/check-demo-frozen.sh` compares it line for line, so the same
// renderer feeds the CLI, the README sample and the page.
//
// ASCII only. Windows terminals still default to cp932 or cp1252 in plenty of
// setups, and a mojibake arrow is a bad first impression for a tool whose job
// is precision.

import { buildPatch } from './patch.js';

const LABEL_WIDTH = 26;
const LINE_WIDTH = 82;
const SUMMARY_WIDTH = 72;
const DETAIL_WIDTH = 78;

/**
 * @param {object} result analyze() result
 * @param {{patch?: boolean, source?: string|null}} options
 */
export function renderText(result, options = {}) {
  if (!result.ok) return renderErrors(result);

  const lines = [];
  lines.push(...verdictLines(result));
  lines.push(checkedLine(result));

  for (const defect of sortDefects(result.defects)) {
    lines.push('');
    lines.push(...renderDefect(result, defect));
  }

  const notes = skippedLines(result);
  if (notes.length > 0) {
    lines.push('');
    lines.push(...notes);
  }

  if (options.patch && options.source) {
    const patch = buildPatch(options.source, result.defects, result.file);
    if (patch) {
      lines.push('');
      lines.push('Suggested patch (printed only - nothing was written):');
      lines.push('');
      lines.push(patch);
    }
  }

  return lines.join('\n');
}

/**
 * Fixed order by measured frequency, not severity or alphabet:
 * ecosystem-absent (36), ignore-no-match (18), directory-no-match (4),
 * no-op-group (2), captured-by-score (0), then flood-risk (an entry that
 * applies and does too much), then source line inside a class.
 */
const CODE_ORDER = [
  'ecosystem-absent',
  'ignore-no-match',
  'directory-no-match',
  'no-op-group',
  'captured-by-score',
  'flood-risk',
];

function sortDefects(defects) {
  return [...defects].sort((a, b) => {
    const rank = CODE_ORDER.indexOf(a.code) - CODE_ORDER.indexOf(b.code);
    if (rank !== 0) return rank;
    return (a.yml_line ?? 0) - (b.yml_line ?? 0);
  });
}

/**
 * Codes that mean "this part of the config can never do anything".
 * `flood-risk` is deliberately absent: an entry that opens too many pull
 * requests does apply, so counting it here would make the sentence lie about
 * its own arithmetic.
 */
const DEAD_CODES = ['ecosystem-absent', 'ignore-no-match', 'directory-no-match', 'no-op-group', 'captured-by-score'];

/** One update entry, keyed the way findings are attributed. */
function entryKey(defect) {
  return defect.ecosystem + '::' + defect.directory;
}

function verdictLines(result) {
  const out = [];
  const defects = result.defects.filter((defect) => defect.severity !== 'info');
  const dead = defects.filter((defect) => DEAD_CODES.includes(defect.code));
  const deadEntries = new Set(dead.map(entryKey)).size;
  const captureEntries = new Set(dead.filter((defect) => defect.code === 'captured-by-score').map(entryKey)).size;
  const capturesOnly = dead.length > 0 && dead.every((defect) => defect.code === 'captured-by-score');
  const skippedEntries = new Set(
    result.skipped
      .filter((item) => item.check === 'dependency-set')
      .map((item) => item.ecosystem + '::' + item.directory),
  ).size;

  if (deadEntries > 0 && !capturesOnly) {
    out.push(
      deadEntries +
        ' entr' +
        (deadEntries === 1 ? 'y' : 'ies') +
        ' in your dependabot.yml ' +
        (deadEntries === 1 ? "doesn't" : "don't") +
        ' apply to this repo.',
    );
  } else if (capturesOnly) {
    out.push(
      captureEntries === 1
        ? '1 entry matched, but lost its dependency to a higher-scoring group.'
        : captureEntries + ' entries matched, but lost their dependencies to a higher-scoring group.',
    );
  } else if (skippedEntries === 0 && result.entries.length > 0) {
    // Only verified when every entry's dependency set was actually enumerated.
    const manifests = Object.values(result.manifests ?? {}).reduce((sum, value) => sum + value, 0);
    out.push(
      'Nothing in your dependabot.yml is dead. We checked ' +
        result.entries.length +
        ' entr' +
        (result.entries.length === 1 ? 'y' : 'ies') +
        ' against ' +
        manifests +
        ' manifest' +
        (manifests === 1 ? '' : 's') +
        '.',
    );
  }

  if (skippedEntries > 0) {
    out.push(skippedEntries === 1 ? "We couldn't check 1 entry." : 'We couldn\'t check ' + skippedEntries + ' entries.');
  }

  // flood-risk is informational, so it is not in `defects` above; it is
  // reported separately and deliberately excluded from the verdict count.
  const floods = result.defects.filter((defect) => defect.code === 'flood-risk');
  if (floods.length > 0) {
    out.push(
      floods.length === 1
        ? 'One more entry applies, but will do too much (listed below, not counted above).'
        : floods.length + ' more entries apply, but will do too much (listed below, not counted above).',
    );
  }
  return out;
}

function checkedLine(result) {
  const ecosystems = Object.entries(result.manifests ?? {});
  const parts = ecosystems.map(([ecosystem, count]) => {
    const noun = manifestNoun(ecosystem);
    return `${count} ${ecosystem} ${noun}${count === 1 ? '' : 's'}`;
  });
  const files = result.files.read;
  const checked = parts.length > 0 ? `Checked ${joinList(parts)}.` : 'Checked no manifests.';
  return `${checked} Read ${files} file${files === 1 ? '' : 's'}.`;
}

function manifestNoun(ecosystem) {
  if (ecosystem === 'github-actions') return 'workflow';
  if (ecosystem === 'docker') return 'Dockerfile';
  return 'manifest';
}

function joinList(parts) {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function renderDefect(result, defect) {
  const lines = [];
  const label = defect.target ?? defect.group ?? defect.ecosystem ?? defect.code;
  const summary = defectSummary(defect);
  const wrapped = wrap(summary, SUMMARY_WIDTH - LABEL_WIDTH);
  const ref = `${result.file.slice(result.file.lastIndexOf('/') + 1)}:${defect.yml_line}`;

  wrapped.forEach((segment, index) => {
    if (index === 0) {
      lines.push(`${label}${' '.repeat(Math.max(1, LABEL_WIDTH - label.length))}${segment}`);
      return;
    }
    lines.push(`${' '.repeat(LABEL_WIDTH)}${segment}`);
  });
  const last = lines[lines.length - 1];
  const pad = Math.max(1, LINE_WIDTH - last.length - ref.length);
  lines[lines.length - 1] = `${last}${' '.repeat(pad)}${ref}`;

  for (const paragraph of defectDetail(result, defect)) {
    for (const line of wrap(paragraph, DETAIL_WIDTH - 2)) lines.push(`  ${line}`);
  }
  return lines;
}

function defectSummary(defect) {
  switch (defect.code) {
    case 'captured-by-score':
      return `${defect.direct_matched_by_rule ?? 0} of ${defect.direct_total ?? 0} direct dependencies matched, then lost to ${defect.winner}`;
    case 'no-op-group':
      if (defect.why === 'allow-excluded') return `matched ${defect.evidence?.rule_matches ?? 0}, but the allow list excludes every one`;
      if (defect.why === 'ignored') return `matched ${defect.evidence?.rule_matches ?? 0}, but every match is fully ignored`;
      if (defect.why === 'empty-patterns') return 'patterns: [] matches nothing, so this group can never fill';
      return `matched 0 of ${defect.direct_total ?? 0} direct dependencies`;
    case 'ignore-no-match':
      return `matches 0 of ${defect.direct_total ?? 0} direct dependencies, so it blocks nothing`;
    case 'directory-no-match':
      return 'matches no directory in this checkout';
    case 'ecosystem-absent':
      return `no ${defect.ecosystem} manifest where this entry looks`;
    case 'flood-risk':
      return `${defect.matched} direct dependencies, daily, no groups`;
    default:
      return defect.code;
  }
}

function defectDetail(result, defect) {
  switch (defect.code) {
    case 'captured-by-score':
      return [captureExplanation(defect), applyScope(defect)];
    case 'no-op-group':
      return [noopExplanation(defect)];
    case 'ignore-no-match':
      return [
        `patterns: [${defect.target}] matched nothing in ${defect.evidence?.dependencies_checked ?? 0} enumerated dependencies, so this rule blocks no update.`,
      ];
    default:
      return [defect.detail ?? ''];
  }
}

function captureExplanation(defect) {
  const names = defect.evidence?.captured_dependencies ?? [];
  const name = names[0] ?? 'this dependency';
  const patterns = defect.evidence?.patterns ?? [];
  const pattern = patterns.length > 0 ? patterns[0] : null;
  const winnerPatterns = defect.evidence?.winner_patterns;
  const scores = defect.scores ?? {};
  if (pattern) {
    const winnerPart =
      winnerPatterns == null
        ? `${defect.winner}, which declares no patterns (scores ${scores.winner})`
        : `${defect.winner}, whose pattern ${winnerPatterns.join(', ')} scores ${scores.winner}`;
    return `${name} matches ${pattern} (scores ${scores.this}) and was assigned to ${winnerPart}.`;
  }
  return `${name} was assigned to ${defect.winner} (scores ${scores.winner} against ${defect.group}).`;
}

function applyScope(defect) {
  const types = defect.effective_update_types;
  if (!types || types.length === 0) return 'Applies to any update type.';
  return `Applies to ${joinList(types)} updates.`;
}

function noopExplanation(defect) {
  const patterns = defect.evidence?.patterns;
  const total = defect.evidence?.dependencies_enumerated ?? 0;
  const rule =
    patterns == null
      ? 'no patterns key, so this group only takes what no pattern group claims'
      : `patterns: [${patterns.join(', ')}]`;
  if (defect.why === 'allow-excluded') {
    return `${rule} matched dependencies, but the entry's allow list excludes every one of them before grouping runs.`;
  }
  if (defect.why === 'ignored') {
    return `${rule} matched dependencies, but an ignore rule removes every one of them at all versions.`;
  }
  if (defect.why === 'empty-patterns') {
    return `the patterns key is present but empty, which scores 0 and matches nothing. Deleting the key instead makes this group a catch-all that scores 500 and can capture dependencies from pattern groups.`;
  }
  return `${rule} matched none of the ${total} dependencies dependabot would enumerate for this entry.`;
}

function skippedLines(result) {
  if (result.skipped.length === 0) return [];
  const seen = new Set();
  const out = ['Not checked:'];
  for (const item of result.skipped) {
    const key = `${item.check}|${item.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`  - ${item.reason}`);
  }
  return out;
}

function renderErrors(result) {
  const invalid = result.errors.some((error) => error.kind === 'invalid-yaml');
  const ours = result.errors.some((error) => error.kind === 'unsupported-yaml');
  const lines = [];
  if (invalid) {
    // Lead with our own failure, then the reason. Our parser has been wrong
    // about valid YAML before; the user's file is not blamed first.
    lines.push("This tool couldn't read this file.");
    lines.push(
      `This isn't valid YAML - ${describe(result.errors.find((error) => error.kind === 'invalid-yaml'))}. No group can be evaluated.`,
    );
  } else if (ours) {
    lines.push(
      `This tool couldn't read this file (${describe(result.errors.find((error) => error.kind === 'unsupported-yaml'))}). That's our parser, not necessarily your config.`,
    );
  } else {
    lines.push(
      `This tool couldn't read this file as a dependabot.yml (${describe(result.errors[0])}). That's our reading of it, not necessarily your config.`,
    );
  }
  for (const error of result.errors) {
    if (error === (invalid ? result.errors.find((item) => item.kind === 'invalid-yaml') : ours ? result.errors.find((item) => item.kind === 'unsupported-yaml') : result.errors[0])) {
      continue;
    }
    lines.push(`  ${describe(error)}: ${error.message}`);
  }
  return lines.join('\n');
}

function describe(error) {
  if (!error) return 'no detail';
  return error.line ? `line ${error.line}: ${error.message}` : error.message;
}

/** Greedy word wrap; never splits a word. */
export function wrap(text, width) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    if (current === '') {
      current = word;
      continue;
    }
    if (`${current} ${word}`.length <= width) {
      current = `${current} ${word}`;
      continue;
    }
    lines.push(current);
    current = word;
  }
  if (current !== '') lines.push(current);
  return lines.length > 0 ? lines : [''];
}
