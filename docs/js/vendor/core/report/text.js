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

function sortDefects(defects) {
  const order = [
    'ecosystem-absent',
    'directory-no-match',
    'no-op-group',
    'captured-by-score',
    'ignore-no-match',
    'flood-risk',
  ];
  return [...defects].sort((a, b) => {
    const byLine = (a.yml_line ?? 0) - (b.yml_line ?? 0);
    if (byLine !== 0) return byLine;
    return order.indexOf(a.code) - order.indexOf(b.code);
  });
}

function verdictLines(result) {
  const { summary } = result;
  const out = [];
  const empty = summary.groups_empty;
  const captured = result.defects.filter((defect) => defect.code === 'captured-by-score').length;
  const groups = summary.groups_total;
  const uncheckable = new Set(
    result.skipped.filter((item) => item.check === 'no-op-group').map((item) => item.group ?? item.reason),
  ).size;

  if (empty > 0) {
    out.push(
      empty === 1
        ? `1 of your ${groups} groups match nothing.`
        : `${empty} of your ${groups} groups match nothing.`,
    );
  }
  if (captured > 0) {
    out.push(
      captured === 1
        ? '1 group matched, but lost its dependency to a higher-scoring group.'
        : `${captured} groups matched, but lost their dependencies to a higher-scoring group.`,
    );
  }
  if (empty === 0 && captured === 0 && groups > 0) {
    out.push(
      groups === 1
        ? 'Your 1 group matches at least one dependency.'
        : `All ${groups} of your groups match at least one dependency.`,
    );
  }
  if (groups === 0 && result.defects.length === 0) {
    out.push('No groups in this config, so there is no grouping to check.');
  }
  if (uncheckable > 0) {
    out.push(uncheckable === 1 ? "We couldn't check 1 group." : `We couldn't check ${uncheckable} groups.`);
  }

  const others = result.defects.filter(
    (defect) => !['no-op-group', 'captured-by-score'].includes(defect.code) && defect.severity !== 'info',
  );
  if (others.length > 0) {
    const parts = [];
    for (const code of ['ignore-no-match', 'directory-no-match', 'ecosystem-absent']) {
      const count = others.filter((defect) => defect.code === code).length;
      if (count === 0) continue;
      const phrase =
        code === 'ignore-no-match'
          ? `ignore rule${count === 1 ? '' : 's'} that ${count === 1 ? 'matches' : 'match'} nothing`
          : code === 'directory-no-match'
            ? `director${count === 1 ? 'y' : 'ies'} not found`
            : `ecosystem${count === 1 ? '' : 's'} with no manifest`;
      parts.push(`${count} ${phrase}`);
    }
    if (parts.length > 0) out.push(`Also: ${parts.join(', ')}.`);
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
