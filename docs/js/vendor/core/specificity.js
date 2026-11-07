// Port of dependabot-core's group pattern specificity scoring.
//
// Source of truth (commit d7b08f3, 2026-11-06):
//   updater/lib/dependabot/updater/pattern_specificity_calculator.rb
//   updater/lib/dependabot/dependency_group_engine.rb
//
// This is what actually decides which group "wins" when several groups match a
// dependency. It is NOT "first group in the file wins": every group that
// contains the dependency keeps it unless another matching group has a strictly
// higher specificity score, in which case the less specific group loses it
// (DependencyGroupEngine#should_skip_due_to_specificity?).
//
// The scoring constants below are copied exactly.

export const EXPLICIT_MEMBER_SCORE = 1000;
export const EXACT_MATCH_SCORE = 1000;
export const NO_WILDCARDS_SCORE = 500;
export const NO_PATTERNS_SCORE = 500;
export const WILDCARD_BASE_SCORE = 100;
export const WILDCARD_PENALTY = 10;
export const UNIVERSAL_WILDCARD_SCORE = 1;
export const MINIMUM_SCORE = 1;
export const LENGTH_BONUS_THRESHOLD = 5;

import { wildcardMatch } from './wildcard.js';

/** `calculate_pattern_specificity` — score for one pattern against one name. */
export function patternSpecificity(pattern, dependencyName) {
  if (pattern === dependencyName) return EXACT_MATCH_SCORE;
  if (pattern === '*') return UNIVERSAL_WILDCARD_SCORE;
  const wildcardCount = (pattern.match(/\*/g) || []).length;
  if (wildcardCount === 0) return NO_WILDCARDS_SCORE;
  const specificity = WILDCARD_BASE_SCORE - wildcardCount * WILDCARD_PENALTY;
  const lengthBonus = Math.max(pattern.length - LENGTH_BONUS_THRESHOLD, 0);
  return Math.max(specificity + lengthBonus, MINIMUM_SCORE);
}

/**
 * `calculate_group_specificity_for_dependency` — best score among the group's
 * patterns that match the dependency. Returns 0 when the group cannot contain
 * the dependency at all.
 *
 * @param {{patterns?: string[]|null, excludePatterns?: string[]|null}} group
 */
export function groupSpecificity(group, dependencyName) {
  if (isExcluded(group, dependencyName)) return 0;
  const patterns = group.patterns;
  if (!patterns) return NO_PATTERNS_SCORE; // no patterns rule == matches everything
  const matching = patterns.filter((pattern) => wildcardMatch(pattern, dependencyName));
  if (matching.length === 0) return 0;
  return Math.max(...matching.map((pattern) => patternSpecificity(pattern, dependencyName)));
}

/** `excluded_by_group?` */
export function isExcluded(group, dependencyName) {
  const excludePatterns = group.excludePatterns;
  if (!excludePatterns) return false;
  return excludePatterns.some((pattern) => wildcardMatch(pattern, dependencyName));
}

/**
 * `dependency_belongs_to_more_specific_group?` — true when this group would
 * lose the dependency to another matching group.
 *
 * @param {object} currentGroup
 * @param {string} dependencyName
 * @param {object[]} groups all groups for the ecosystem entry
 * @param {{updateType?: string|null}} [options]
 */
export function belongsToMoreSpecificGroup(currentGroup, dependencyName, groups, options = {}) {
  const patterns = currentGroup.patterns;
  if (!patterns || patterns.length === 0) return false;
  if (isExcluded(currentGroup, dependencyName)) return false;

  const currentScore = groupSpecificity(currentGroup, dependencyName);
  if (currentScore >= EXPLICIT_MEMBER_SCORE) return false;

  const updateType = options.updateType ?? null;
  return groups.some((other) => {
    if (other === currentGroup) return false;
    if (!updateTypeAllowed(other, updateType)) return false;
    if (!appliesToAllowed(other, options.appliesTo ?? null)) return false;
    if (!contains(other, dependencyName, options.dependencyType)) return false;
    return groupSpecificity(other, dependencyName) > currentScore;
  });
}

/**
 * `DependencyGroup#contains?`: patterns + exclude-patterns + dependency-type.
 *
 * `dependencyType` is 'production' | 'development' | 'unknown' (or undefined).
 * Unknown means we could not determine it from the checked-in files; we then
 * refuse to exclude the dependency, because silence is cheaper than a wrong
 * "you are not in this group".
 */
export function contains(group, dependencyName, dependencyType) {
  if (isExcluded(group, dependencyName)) return false;
  if (group.dependencyType && dependencyType && dependencyType !== 'unknown' && dependencyType !== group.dependencyType) {
    return false;
  }
  const patterns = group.patterns;
  if (!patterns) return true;
  return patterns.some((pattern) => wildcardMatch(pattern, dependencyName));
}

/** `update_type_allowed?` */
export function updateTypeAllowed(group, updateType) {
  if (updateType == null) return true;
  const groupUpdateTypes = group.updateTypes;
  if (!groupUpdateTypes) return true;
  return groupUpdateTypes.includes(updateType);
}

/** `applies_to_allowed?` */
export function appliesToAllowed(group, appliesTo) {
  if (appliesTo == null) return true;
  const groupAppliesTo = group.appliesTo;
  if (groupAppliesTo == null) return true;
  return groupAppliesTo === appliesTo;
}
