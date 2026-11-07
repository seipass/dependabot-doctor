// Port of dependabot-core's wildcard matching.
//
// Source of truth:
//   common/lib/dependabot/config/update_config.rb  (self.wildcard_match?)
//   common/lib/dependabot/dependency_group.rb      (matches_pattern?, WildcardMatcher.match?)
// Both go through the `wildcard_matcher` gem, whose matching is:
//   downcase both sides, `*` -> `.*`, everything else regex-quoted, anchored.
// Notably `?` is NOT a wildcard, and the match is anchored end to end.

/** dependabot-core `UpdateConfig.wildcard_match?(wildcard, candidate)` verbatim. */
export function wildcardMatch(wildcard, candidate) {
  if (typeof wildcard !== 'string' || typeof candidate !== 'string') return false;
  const pattern = wildcard
    .toLowerCase()
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${pattern}$`).test(candidate.toLowerCase());
}

/** True when a pattern contains a wildcard character (`*`). */
export function hasWildcard(pattern) {
  return typeof pattern === 'string' && pattern.includes('*');
}
