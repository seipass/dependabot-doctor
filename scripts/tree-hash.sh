#!/usr/bin/env bash
# tree-hash.sh — reproducible identity for this repository's reviewed source.
#
# Why this exists: release notes claim a sha256 over "the source tree". A
# stranger holding the artifact must be able to recompute it, or the number is
# an assertion rather than evidence. It is shipped inside the repo for exactly
# that reason.
#
# Definition (no ambiguity):
#   - input   : every file `git ls-files` reports (tracked files only)
#   - order   : LC_ALL=C sort, byte order
#   - stream  : for each path, the path, a newline, the file's bytes, then NUL
#   - digest  : sha256 of that stream
#
# Tracked-files-only means node_modules, build output and anything gitignored
# are excluded without a hand-maintained skip list, which is what makes the
# number reproducible on any machine.
#
# Usage: ./scripts/tree-hash.sh
# Exit:  0 ok · 2 not a git repository

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "error: not a git repository — nothing to hash" >&2
  exit 2
fi

FILES="$(git ls-files | LC_ALL=C sort)"
COUNT="$(printf '%s\n' "$FILES" | grep -c . || true)"

HASH="$(
  {
    printf '%s\n' "$FILES" | while IFS= read -r f; do
      [ -n "$f" ] || continue
      printf '%s\n' "$f"
      cat -- "$f"
      printf '\0'
    done
  } | sha256sum | cut -d' ' -f1
)"

printf 'files=%s  sha256=%s\n' "$COUNT" "$HASH"
printf 'definition: sha256 over sorted `git ls-files`, each as "<path>\\n<bytes>\\0"\n' >&2
