// The checks. Every defect produced here satisfies two rules:
//
//   1. It cites the dependabot.yml line it is about.
//   2. It only exists when the dependency set for that ecosystem was fully
//      enumerated from files that are actually checked in. Otherwise the check
//      is *skipped* with a reason, and no defect is emitted.
//
// Rule 2 is the whole product. A false "your ignore rule is dead" is worse than
// silence, so anything we cannot prove is reported as skipped, never as a
// defect.

import { expandDirectory, isGlob } from './glob.js';
import { collectForEntry } from './deps/index.js';
import { pep503, usesPep503 } from './deps/util.js';
import { contains, belongsToMoreSpecificGroup, groupSpecificity } from './specificity.js';
import { wildcardMatch } from './wildcard.js';
import { hasDetector, manifestPresent, detectorDescription } from './manifests.js';

/** Ecosystems where dependabot honours a group's `dependency-type` rule. */
const DEPENDENCY_TYPE_ECOSYSTEMS = ['bundler', 'composer', 'hex', 'maven', 'npm', 'pip', 'uv'];
const TOP_LEVEL_TYPES = ['direct', 'production', 'development'];
/** Below this many direct dependencies a daily schedule is not a flood. */
const FLOOD_DIRECT_THRESHOLD = 20;
const DEFAULT_OPEN_PR_LIMIT = 5;

/**
 * Run every check for a parsed config.
 *
 * @param {{config: object, ctx: object}} input
 */
export function runChecks({ config, ctx }) {
  const defects = [];
  const skipped = [];
  const depCache = new Map();

  const skip = (code, reason, extra = {}) => skipped.push({ check: code, reason, ...extra });

  const collect = (entry, resolved) => {
    const key = `${entry.ecosystem}|${resolved.join(',')}`;
    if (!depCache.has(key)) depCache.set(key, collectForEntry(ctx, entry, resolved));
    return depCache.get(key);
  };

  const hasRepositoryContents = ctx.filePaths.length > 0;

  for (const entry of config.entries) {
    // `patterns: []` scores 0 and matches nothing as a matter of the config
    // alone - no manifest, lockfile or tree is needed to prove it. Reported
    // before any repository-dependent check so a pasted config (no repo view at
    // all) still gets this one certain finding.
    for (const group of entry.groups) {
      if (group.appliesTo !== 'version-updates') continue;
      if (!Array.isArray(group.patterns) || group.patterns.length > 0) continue;
      defects.push(groupDefect(entry, group, 'empty-patterns', [], [], { total: 0, directTotal: 0 }));
    }

    const declared = entry.directories;
    const resolved = [];
    const unmatched = [];
    for (const pattern of declared) {
      const matches = expandDirectory(pattern, ctx.directories);
      if (matches.length === 0) unmatched.push(pattern);
      for (const match of matches) if (!resolved.includes(match)) resolved.push(match);
    }

    if (!hasRepositoryContents) {
      skip('repository-contents', 'no repository contents were provided, so directory and ecosystem checks were not run', {
        ecosystem: entry.ecosystem,
        directory: declared.join(', '),
      });
      continue;
    }

    for (const pattern of unmatched) {
      const declaredLine = (entry.directoryLines.find((item) => item.path === pattern) || {}).line ?? entry.directoryLine;
      defects.push({
        code: 'directory-no-match',
        severity: 'error',
        ecosystem: entry.ecosystem,
        directory: pattern,
        target: pattern,
        group: null,
        matched: 0,
        total: ctx.directories.length,
        direct_total: 0,
        yml_line: declaredLine,
        detail: isGlob(pattern)
          ? `"${pattern}" matches none of the ${ctx.directories.length} directories in this checkout, so this update entry never runs`
          : `directory "${pattern}" does not exist in this checkout, so this update entry never runs`,
        evidence: { directories_scanned: ctx.directories.length },
        suggestion:
          'Fix the path, or delete this update entry. Paths start with "/" and are relative to the repository root; only `directories:` accepts globs.',
        _loc: { start: entry.line, end: entry.endLine },
      });
    }

    if (resolved.length === 0) continue;

    if (hasDetector(entry.ecosystem) && !manifestPresent(entry.ecosystem, ctx.slashPaths, resolved)) {
      defects.push({
        code: 'ecosystem-absent',
        severity: 'error',
        ecosystem: entry.ecosystem,
        directory: declared.join(', '),
        target: entry.ecosystem,
        group: null,
        matched: 0,
        total: resolved.length,
        direct_total: 0,
        yml_line: entry.line,
        detail: `"package-ecosystem: ${entry.ecosystem}" is configured for ${declared.join(', ')}, but no ${entry.ecosystem} manifest exists there (looked for ${detectorDescription(entry.ecosystem)})`,
        evidence: { resolved_directories: resolved, looked_for: detectorDescription(entry.ecosystem) },
        suggestion: `Delete this update entry, or add the missing manifest. Nothing under ${declared.join(', ')} is updatable by dependabot as ${entry.ecosystem}.`,
        _loc: { start: entry.line, end: entry.endLine },
      });
      continue;
    }

    const dependencySet = collect(entry, resolved);
    if (!dependencySet.supported) {
      skip('dependency-set', dependencySet.reason, { ecosystem: entry.ecosystem, directory: declared.join(', ') });
      continue;
    }
    if (!dependencySet.complete) {
      skip('dependency-set', `${entry.ecosystem} at ${declared.join(', ')}: ${dependencySet.reason}`, {
        ecosystem: entry.ecosystem,
        directory: declared.join(', '),
      });
    }

    if (dependencySet.complete) {
      checkGroups(entry, dependencySet, ctx, defects, skip);
      checkIgnoreRules(entry, dependencySet, defects);
    }
    checkFloodRisk(entry, dependencySet, defects, skip);
  }

  return { defects, skipped };
}

// ---------------------------------------------------------------------------
// groups
// ---------------------------------------------------------------------------

function checkGroups(entry, dependencySet, ctx, defects, skip) {
  const groups = entry.groups.filter((group) => {
    if (group.appliesTo !== 'version-updates') return false;
    if (group.groupBy === 'dependency-name') return false;
    // an empty patterns list is reported from the config alone
    if (Array.isArray(group.patterns) && group.patterns.length === 0) return false;
    return true;
  });

  for (const group of entry.groups) {
    if (group.appliesTo === 'security-updates') {
      skip('no-op-group', `group "${group.name}" applies to security updates only; the vulnerable-dependency set is not knowable offline`, {
        ecosystem: entry.ecosystem,
        directory: entry.directories.join(', '),
        group: group.name,
      });
    }
    if (group.groupBy === 'dependency-name') {
      skip('no-op-group', `group "${group.name}" uses group-by: dependency-name, which splits into per-dependency subgroups`, {
        ecosystem: entry.ecosystem,
        directory: entry.directories.join(', '),
        group: group.name,
      });
    }
  }

  if (groups.length === 0) return;
  if (entry.openPullRequestsLimit === 0) {
    skip(
      'no-op-group',
      `group(s) ${groups.map((group) => group.name).join(', ')} belong to an entry with open-pull-requests-limit: 0, which disables version updates (security updates only)`,
      { ecosystem: entry.ecosystem, directory: entry.directories.join(', '), group: groups.map((group) => group.name).join(', ') },
    );
    return;
  }
  if (entry.groups.some((group) => group.dependencyType) && !DEPENDENCY_TYPE_ECOSYSTEMS.includes(entry.ecosystem)) {
    const unsupported = entry.groups.filter((group) => group.dependencyType).map((group) => group.name);
    skip('no-op-group', `group(s) ${unsupported.join(', ')} use dependency-type, which dependabot ignores for ${entry.ecosystem}`, {
      ecosystem: entry.ecosystem,
      directory: entry.directories.join(', '),
    });
    return;
  }

  const deps = [...dependencySet.deps.values()];
  const directTotal = deps.filter((dep) => dep.direct).length;

  for (const group of groups) {
    const ruleMatches = deps.filter((dep) => contains(group, matchNameValue(entry.ecosystem, dep)));
    let candidates = ruleMatches;
    let unknownTypes = 0;
    if (group.dependencyType) {
      candidates = ruleMatches.filter((dep) => dep.type !== 'unknown' && dep.type === group.dependencyType);
      unknownTypes = ruleMatches.filter((dep) => dep.type === 'unknown').length;
    }
    if (candidates.length === 0 && unknownTypes > 0) {
      skip(
        'no-op-group',
        `group "${group.name}" uses dependency-type: ${group.dependencyType}, but the production/development status of ${unknownTypes} matching dependency(ies) cannot be determined from the checked-in files`,
        { ecosystem: entry.ecosystem, directory: entry.directories.join(', '), group: group.name },
      );
      continue;
    }
    if (candidates.length === 0) {
      const why = Array.isArray(group.patterns) && group.patterns.length === 0 ? 'empty-patterns' : 'zero-match';
      defects.push(groupDefect(entry, group, why, [], [], { total: deps.length, directTotal }));
      continue;
    }

    const losers = candidates.filter((dep) =>
      belongsToMoreSpecificGroup(group, matchNameValue(entry.ecosystem, dep), entry.groups, {
        appliesTo: 'version-updates',
        dependencyType: dep.type,
      }),
    );
    const survivors = candidates.filter((dep) => !losers.includes(dep));
    if (survivors.length === 0) {
      const capture = scoreCapture(entry, group, losers);
      if (capture.winner) {
        defects.push(capturedDefect(entry, group, losers, { total: deps.length, directTotal }, capture));
      } else {
        skip(
          'no-op-group',
          `group "${group.name}": every matching dependency is outscored by another group, but the scoring depends on update types this tool cannot evaluate`,
          { ecosystem: entry.ecosystem, directory: entry.directories.join(', '), group: group.name },
        );
      }
      continue;
    }

    const allowVerdicts = survivors.map((dep) => allowVerdict(entry, dep, entry.ecosystem));
    if (allowVerdicts.includes(null)) {
      skip('no-op-group', `group "${group.name}": the allow list uses update-type rules whose effect on version updates cannot be modelled offline`, {
        ecosystem: entry.ecosystem,
        directory: entry.directories.join(', '),
        group: group.name,
      });
      continue;
    }
    const allowed = survivors.filter((dep, index) => allowVerdicts[index]);
    if (allowed.length === 0) {
      defects.push(groupDefect(entry, group, 'allow-excluded', survivors, [], { total: deps.length, directTotal }));
      continue;
    }

    const notIgnored = allowed.filter((dep) => !entirelyIgnored(entry, dep, entry.ecosystem));
    if (notIgnored.length === 0) {
      defects.push(groupDefect(entry, group, 'ignored', allowed, [], { total: deps.length, directTotal }));
    }
  }
}

function groupDefect(entry, group, why, matching, _winners, counts) {
  const total = counts.total;
  const directTotal = counts.directTotal;
  const directMatches = matching.filter((dep) => dep.direct).length;
  const universe =
    total === directTotal
      ? `0 of ${total} dependencies`
      : `0 of ${directTotal} direct dependencies (${total} including lockfile-only packages)`;
  const patterns = group.patterns ? `[${group.patterns.join(', ')}]` : '(no patterns: matches everything)';
  const excludes = group.excludePatterns ? `, exclude-patterns [${group.excludePatterns.join(', ')}]` : '';
  const typeRule = group.dependencyType ? `, dependency-type: ${group.dependencyType}` : '';
  const rule = DEPENDENCY_TYPE_ECOSYSTEMS.includes(entry.ecosystem)
    ? `patterns ${patterns}${excludes}${typeRule}`
    : `patterns ${patterns}${excludes}`;
  const base = {
    code: 'no-op-group',
    severity: 'warning',
    ecosystem: entry.ecosystem,
    directory: entry.directories.join(', '),
    target: group.name,
    group: group.name,
    matched: 0,
    reaching: 0,
    matched_by_rule: matching.length,
    direct_matched_by_rule: directMatches,
    total,
    direct_total: directTotal,
    why,
    yml_line: group.line,
    evidence: {
      patterns: group.patterns,
      exclude_patterns: group.excludePatterns,
      dependency_type: group.dependencyType,
      rule_matches: matching.length,
      direct_rule_matches: directMatches,
      direct_dependencies_enumerated: directTotal,
      rule_match_names: matching.slice(0, 10).map((dep) => dep.name),
      dependencies_enumerated: total,
    },
    _loc: {
      start: group.line,
      end: group.endLine,
      parentStart: entry.groupsLine,
      parentEnd: entry.groupsEndLine,
      groupCount: entry.groups.length,
    },
  };
  if (why === 'empty-patterns') {
    return {
      ...base,
      detail: `group "${group.name}" has an empty patterns list, which matches no dependency at all (0 of ${total}); unlike an absent patterns key, an empty list scores 0`,
      suggestion: `Give the group at least one pattern, or delete the patterns key. Careful: deleting the key turns this group into a catch-all that scores 500 and can capture dependencies from pattern groups (that is dependabot-core#14576).`,
    };
  }
  if (why === 'zero-match') {
    return {
      ...base,
      detail: `group "${group.name}" is empty: ${universe} match its rules (${rule})`,
      suggestion: group.dependencyType
        ? 'Remove or widen the dependency-type rule, or delete the group: the type filter is what excludes every match here, so a wider pattern cannot help.'
        : "Delete the group, or widen its patterns. Dependabot's only signal for this is a WARN line in the update-job log.",
    };
  }
  if (why === 'allow-excluded') {
    return {
      ...base,
      detail: `group "${group.name}" is empty: its rules match ${matching.length} dependencies (${matching
        .slice(0, 5)
        .map((dep) => dep.name)
        .join(', ')}), but the entry's allow list excludes every one of them; ${universe} reach it`,
      suggestion:
        'Widen the allow list, or delete the group. Dependabot runs allow filtering before grouping and names this exact cause in its "no dependencies match" warning.',
    };
  }
  return {
    ...base,
    detail: `group "${group.name}" is empty: its rules match ${matching.length} dependencies, but every one of them is fully ignored by an ignore rule; ${universe} reach it`,
    suggestion: 'Remove the overlapping ignore rule, or delete the group. A dependency ignored at all versions never enters a group.',
  };
}

/**
 * Work out which group outranks this one, and by how much.
 *
 * `thisScore` is the best score this group achieves on any of its matching
 * dependencies (the most favourable case for the group). If even that loses,
 * the capture is certain.
 */
function scoreCapture(entry, group, losers) {
  const winners = new Map();
  let thisScore = 0;
  let basis = null;
  for (const dep of losers) {
    const name = matchNameValue(entry.ecosystem, dep);
    const mine = groupSpecificity(group, name);
    if (mine > thisScore) {
      thisScore = mine;
      basis = dep.name;
    }
    for (const other of entry.groups) {
      if (other === group || other.appliesTo !== 'version-updates') continue;
      // Groups with disjoint update-types are complementary, not competing. We
      // cannot see which update types are pending, so we stay quiet instead of
      // claiming a capture that may never happen.
      if (!complementaryUpdateTypes(group, other)) continue;
      if (!contains(other, name, dep.type)) continue;
      const theirs = groupSpecificity(other, name);
      if (theirs <= mine) continue;
      const record = winners.get(other.name) ?? { name: other.name, score: theirs, count: 0, sample: dep.name };
      record.count += 1;
      if (theirs > record.score) record.score = theirs;
      winners.set(other.name, record);
    }
  }
  if (winners.size === 0) return { winner: null, thisScore, basis };
  const ranked = [...winners.values()].sort((a, b) => b.score - a.score || b.count - a.count);
  return { winner: ranked[0], others: ranked.slice(1), thisScore, basis, captured: losers.length };
}

function complementaryUpdateTypes(a, b) {
  if (!a.updateTypes || !b.updateTypes) return true;
  return a.updateTypes.some((value) => b.updateTypes.includes(value));
}

function shortUpdateType(value) {
  const match = /^version-update:semver-(major|minor|patch)$/.exec(value);
  return match ? match[1] : value;
}

function capturedDefect(entry, group, losers, counts, capture) {
  const total = counts.total;
  const directTotal = counts.directTotal;
  const directCaptured = losers.filter((dep) => dep.direct).length;
  const winnerGroup = entry.groups.find((item) => item.name === capture.winner.name) ?? {};
  const effectiveUpdateTypes = winnerGroup.updateTypes ?? group.updateTypes ?? null;
  const universe =
    total === directTotal
      ? `0 of ${total} dependencies reach it`
      : `0 of ${directTotal} direct dependencies reach it (${losers.length} of ${total} including lockfile-only packages)`;
  const updateTypes = group.updateTypes ? group.updateTypes.map(shortUpdateType) : null;
  const winnerUpdateTypes = winnerGroup.updateTypes ? winnerGroup.updateTypes.map(shortUpdateType) : null;
  const effective = effectiveUpdateTypes ? effectiveUpdateTypes.map(shortUpdateType) : null;
  const scope = effective
    ? `Applies to ${effective.length === 1 ? effective[0] : `${effective.slice(0, -1).join(', ')} and ${effective[effective.length - 1]}`} updates.`
    : 'Applies to any update type.';
  return {
    code: 'captured-by-score',
    severity: 'warning',
    ecosystem: entry.ecosystem,
    directory: entry.directories.join(', '),
    target: group.name,
    group: group.name,
    winner: capture.winner.name,
    scores: { this: capture.thisScore, winner: capture.winner.score },
    update_types: updateTypes,
    winner_update_types: winnerUpdateTypes,
    effective_update_types: effective,
    matched: 0,
    reaching: 0,
    matched_by_rule: losers.length,
    direct_matched_by_rule: directCaptured,
    total,
    direct_total: directTotal,
    why: 'captured',
    yml_line: group.line,
    detail:
      `group "${group.name}" matched ${directCaptured} of ${directTotal} direct dependencies, then lost them: ` +
      `group "${capture.winner.name}" scores higher (${capture.winner.score} vs ${capture.thisScore}) ` +
      `and takes every one of them; ${universe}. ` +
      `${scope} Scores: exact name 1000, no wildcard 500, no patterns at all 500, wildcard 100-10n+len, "*" 1.`,
    evidence: {
      patterns: group.patterns,
      exclude_patterns: group.excludePatterns,
      captured_dependencies: losers.slice(0, 10).map((dep) => dep.name),
      direct_captured: directCaptured,
      captured_count: losers.length,
      winner: capture.winner.name,
      winner_score: capture.winner.score,
      winner_patterns: (entry.groups.find((item) => item.name === capture.winner.name) || {}).patterns ?? null,
      other_winners: capture.others.length > 0 ? capture.others.map((item) => item.name) : undefined,
      score_basis: capture.basis,
      dependencies_enumerated: total,
    },
    suggestion: `Delete "${group.name}", or make it outrank "${capture.winner.name}": an exact dependency name scores 1000, a pattern without wildcards 500, a group with no patterns at all 500, and wildcards score 100-10n+length.`,
    _loc: {
      start: group.line,
      end: group.endLine,
      parentStart: entry.groupsLine,
      parentEnd: entry.groupsEndLine,
      groupCount: entry.groups.length,
    },
  };
}

// ---------------------------------------------------------------------------
// ignore
// ---------------------------------------------------------------------------

function checkIgnoreRules(entry, dependencySet, defects) {
  const deps = [...dependencySet.deps.values()];
  const directTotal = deps.filter((dep) => dep.direct).length;
  for (const rule of entry.ignore) {
    const matched = deps.filter((dep) => nameMatches(entry.ecosystem, rule.dependencyName, dep));
    if (matched.length > 0) continue;
    const sample = deps.slice(0, 5).map((dep) => dep.name);
    defects.push({
      code: 'ignore-no-match',
      severity: 'warning',
      ecosystem: entry.ecosystem,
      directory: entry.directories.join(', '),
      target: rule.dependencyName,
      group: null,
      matched: 0,
      total: deps.length,
      direct_total: directTotal,
      why: 'zero-match',
      yml_line: rule.keyLine,
      detail: `ignore rule "dependency-name: ${rule.dependencyName}" matches 0 of ${deps.length} dependencies enumerated for ${entry.ecosystem}${deps.length ? ` (e.g. ${sample.join(', ')})` : ''}`,
      evidence: {
        pattern: rule.dependencyName,
        dependencies_checked: deps.length,
        direct_dependencies_checked: directTotal,
        sources: dependencySet.sources,
        versions: rule.versions,
        update_types: rule.updateTypes,
      },
      suggestion: 'Fix the spelling, or delete the rule. Nothing is being ignored by it today.',
      _loc: { start: rule.line, end: rule.endLine, parentStart: entry.ignoreLine, parentEnd: entry.ignoreEndLine, itemCount: entry.ignore.length },
    });
  }
}

// ---------------------------------------------------------------------------
// flood risk
// ---------------------------------------------------------------------------

function checkFloodRisk(entry, dependencySet, defects, skip) {
  // open-pull-requests-limit: 0 disables version updates entirely; that is a
  // deliberate security-only setup, not a flood.
  if (entry.openPullRequestsLimit === 0) return;
  if (!entry.schedule || entry.schedule.interval !== 'daily') return;
  const versionUpdateGroups = entry.groups.filter((group) => group.appliesTo === 'version-updates');
  if (versionUpdateGroups.length > 0) return;
  const limit = entry.openPullRequestsLimit ?? DEFAULT_OPEN_PR_LIMIT;
  if (limit > DEFAULT_OPEN_PR_LIMIT) return;
  if (!dependencySet.supported) return;
  const directDeps = [...dependencySet.deps.values()].filter((dep) => dep.direct);
  const direct = directDeps.length;
  if (direct < FLOOD_DIRECT_THRESHOLD) return;
  // A config that ignores minor and patch for every dependency only ever opens
  // PRs for majors, so a capped queue is not a flood. Stay quiet.
  const minorAndPatchIgnored = directDeps.filter((dep) => {
    return entry.ignore.some((rule) => {
      if (rule.versions.length > 0) return false;
      if (!nameMatches(entry.ecosystem, rule.dependencyName, dep)) return false;
      const types = rule.updateTypes;
      return types.includes('version-update:semver-minor') && types.includes('version-update:semver-patch');
    });
  }).length;
  if (minorAndPatchIgnored === direct) {
    skip('flood-risk', `${entry.ecosystem} at ${entry.directories.join(', ')}: every direct dependency ignores minor and patch updates, so only major updates open pull requests`, {
      ecosystem: entry.ecosystem,
      directory: entry.directories.join(', '),
    });
    return;
  }
  if (dependencySet.deps.size === 0) {
    skip('flood-risk', `${entry.ecosystem} at ${entry.directories.join(', ')}: no dependencies enumerated`, {
      ecosystem: entry.ecosystem,
      directory: entry.directories.join(', '),
    });
    return;
  }
  defects.push({
    code: 'flood-risk',
    severity: 'info',
    ecosystem: entry.ecosystem,
    directory: entry.directories.join(', '),
    target: `${entry.schedule.interval} schedule`,
    group: null,
    matched: direct,
    total: dependencySet.deps.size,
    direct_total: direct,
    why: 'capacity',
    yml_line: entry.schedule.line,
    detail: `daily updates, no groups and open-pull-requests-limit ${entry.openPullRequestsLimit == null ? `${DEFAULT_OPEN_PR_LIMIT} (default)` : entry.openPullRequestsLimit} across ${direct} direct dependencies: at most ${limit} pull requests can be open at once, so the queue can never drain and the oldest dependencies are effectively never updated`,
    evidence: { direct_dependencies: direct, open_pull_requests_limit: limit },
    suggestion: 'Group minor and patch updates, or set a weekly schedule. This is a capacity risk, not a config error.',
    _loc: { start: entry.line, end: entry.endLine },
  });
}

// ---------------------------------------------------------------------------
// precedence helpers
// ---------------------------------------------------------------------------

/** The string dependabot matches patterns against for this ecosystem. */
export function matchNameValue(ecosystem, dep) {
  return usesPep503(ecosystem) ? dep.normalized : dep.name;
}

/** Pattern-vs-dependency name match, including PEP 503 normalization for pip/uv. */
export function nameMatches(ecosystem, pattern, dep) {
  if (typeof pattern !== 'string') return false;
  if (usesPep503(ecosystem)) {
    if (wildcardMatch(pep503(pattern), dep.normalized)) return true;
  }
  return wildcardMatch(pattern, dep.name);
}

/**
 * Port of `Job#allowed_update?` (updater/lib/dependabot/job.rb, commit d7b08f3).
 * Returns true/false, or null when a rule depends on information we do not have
 * (a security-only rule, or a dependency whose production/development status we
 * could not determine).
 */
export function allowVerdict(entry, dep, ecosystem) {
  if (entry.allow.length === 0) return true;
  let uncertain = false;
  for (const rule of entry.allow) {
    if (rule.updateType || (rule.updateTypes && rule.updateTypes.length > 0)) {
      uncertain = true;
      continue;
    }
    const conditionName = rule.dependencyName ?? dep.name;
    if (!nameMatches(ecosystem, conditionName, dep)) continue;
    const type = rule.dependencyType ?? 'all';
    if (type === 'indirect' && dep.direct) continue;
    if (!dep.direct && TOP_LEVEL_TYPES.includes(type)) continue;
    if (dep.type === 'unknown' && (type === 'production' || type === 'development')) {
      uncertain = true;
      continue;
    }
    if (dep.type === 'production' && type === 'development') continue;
    if (dep.type !== 'production' && type === 'production') continue;
    return true;
  }
  return uncertain ? null : false;
}

/** True when an ignore rule removes every version of this dependency. */
export function entirelyIgnored(entry, dep, ecosystem) {
  return entry.ignore.some(
    (rule) =>
      nameMatches(ecosystem, rule.dependencyName, dep) && rule.versions.length === 0 && rule.updateTypes.length === 0,
  );
}
