import { readFileSync, writeFileSync } from 'node:fs';

const path = new URL('../core/report/text.js', import.meta.url);
let s = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

const start = s.indexOf('function verdictLines(result) {');
const end = s.indexOf('function checkedLine(result) {', start);
if (start < 0 || end < 0) throw new Error('verdictLines anchors not found');

const block = String.raw`/**
 * Codes that mean "this part of the config can never do anything".
 * \`flood-risk\` is deliberately absent: an entry that opens too many pull
 * requests does apply, so counting it here would make the sentence lie about
 * its own arithmetic.
 */
const DEAD_CODES = ['ecosystem-absent', 'ignore-no-match', 'directory-no-match', 'no-op-group', 'captured-by-score'];

/** One update entry, keyed the way findings are attributed. */
function entryKey(defect) {
  return `${defect.ecosystem}::${defect.directory}`;
}

function entryLabel(count) {
  return count === 1 ? '1 entry' : `${count} entries`;
}

function verdictLines(result) {
  const out = [];
  const defects = result.defects.filter((defect) => defect.severity !== 'info');
  const dead = defects.filter((defect) => DEAD_CODES.includes(defect.code));
  const deadEntries = new Set(dead.map(entryKey)).size;
  const captureEntries = new Set(dead.filter((defect) => defect.code === 'captured-by-score').map(entryKey)).size;
  const capturesOnly = dead.length > 0 && dead.every((defect) => defect.code === 'captured-by-score');
  const skippedEntries = new Set(
    result.skipped.filter((item) => item.check === 'dependency-set').map((item) => `${item.ecosystem}::${item.directory}`),
  ).size;

  if (deadEntries > 0 && !capturesOnly) {
    out.push(
      `${entryLabel(deadEntries)} in your dependabot.yml ${deadEntries === 1 ? "doesn't" : "don't"} apply to this repo.`,
    );
  } else if (capturesOnly) {
    out.push(
      captureEntries === 1
        ? '1 entry matched, but lost its dependency to a higher-scoring group.'
        : `${captureEntries} entries matched, but lost their dependencies to a higher-scoring group.`,
    );
  } else if (skippedEntries === 0 && result.entries.length > 0) {
    // Only verified when every entry's dependency set was actually enumerated.
    const manifests = Object.values(result.manifests ?? {}).reduce((sum, value) => sum + value, 0);
    out.push(
      `Nothing in your dependabot.yml is dead. We checked ${result.entries.length} ` +
        `entr${result.entries.length === 1 ? 'y' : 'ies'} against ${manifests} manifest${manifests === 1 ? '' : 's'}.`,
    );
  }

  if (skippedEntries > 0) {
    out.push(
      skippedEntries === 1 ? "We couldn't check 1 entry." : `We couldn't check ${skippedEntries} entries.`,
    );
  }

  const floods = defects.filter((defect) => defect.code === 'flood-risk');
  if (floods.length > 0) {
    out.push(
      floods.length === 1
        ? 'One more entry applies, but will do too much (listed below, not counted above).'
        : `${floods.length} more entries apply, but will do too much (listed below, not counted above).`,
    );
  }
  return out;
}

`;
s = s.slice(0, start) + block + s.slice(end);

// frequency order, flood-risk last
const sortStart = s.indexOf('function sortDefects(defects) {');
const sortEnd = s.indexOf('function verdictLines(result) {', sortStart);
if (sortStart < 0 || sortEnd < 0) throw new Error('sortDefects anchors not found');
const sortBlock = String.raw`/**
 * Fixed order by measured frequency, not severity or alphabet:
 * ecosystem-absent (36), ignore-no-match (18), directory-no-match (4),
 * no-op-group (2), captured-by-score (0), then flood-risk (an entry that
 * applies and does too much), then line number inside a class.
 */
const CODE_ORDER = ['ecosystem-absent', 'ignore-no-match', 'directory-no-match', 'no-op-group', 'captured-by-score', 'flood-risk'];

function sortDefects(defects) {
  return [...defects].sort((a, b) => {
    const rank = CODE_ORDER.indexOf(a.code) - CODE_ORDER.indexOf(b.code);
    if (rank !== 0) return rank;
    return (a.yml_line ?? 0) - (b.yml_line ?? 0);
  });
}

`;
s = s.slice(0, sortStart) + sortBlock + s.slice(sortEnd);
writeFileSync(path, s);
console.log('patched text.js');
