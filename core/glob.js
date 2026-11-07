// `directories:` globbing.
//
// dependabot.yml's `directories` key supports `*` wildcards (one path segment),
// per the options reference:
//   "The directories key supports globbing and the wildcard character *".
// `*` never crosses a `/`. We additionally accept `**` (any number of
// segments) because a narrower matcher than dependabot's could turn a working
// glob into a false "matches nothing" finding. Matching is case-sensitive,
// like paths on GitHub.

/** Compile a dependabot `directories` pattern into a RegExp over "/a/b" paths. */
export function compileDirectoryGlob(pattern) {
  const segments = String(pattern).split('/').filter((segment) => segment !== '');
  let source = '';
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === '**') {
      source += last ? '(?:/[^/]+)*' : '(?:/[^/]+)*';
      return;
    }
    const body = segment
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^/]*');
    source += `/${body}`;
  });
  if (segments.length === 0) source = '/';
  return new RegExp(`^${source}$`);
}

/** True when the pattern contains a wildcard. */
export function isGlob(pattern) {
  return String(pattern).includes('*');
}

/**
 * Expand one declared directory/glob against every directory in the checkout.
 * @param {string} pattern normalized directory or glob (leading "/")
 * @param {string[]} directories normalized directory paths from the scan
 */
export function expandDirectory(pattern, directories) {
  if (!isGlob(pattern)) return directories.includes(pattern) ? [pattern] : [];
  const re = compileDirectoryGlob(pattern);
  return directories.filter((dir) => re.test(dir));
}
