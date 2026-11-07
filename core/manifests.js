// "Is there a manifest for this ecosystem here?" — used by the
// ecosystem-absent check, and only there.
//
// The rule is deliberately conservative: a detector exists for every ecosystem
// where we are confident about the file names dependabot reads. We never report
// an ecosystem as absent when no detector exists (see SUPPORTED). Presence is
// searched recursively below the declared directory, which makes "absent" a
// stronger claim than dependabot's own single-directory lookup — a finding here
// is therefore always safe, at the cost of a few missed cases.

const FILE_PATTERNS = {
  npm: [/(^|\/)package\.json$/],
  bun: [/(^|\/)bun\.lockb?$/, /(^|\/)package\.json$/],
  pip: [
    /(^|\/)requirements[^/]*\.(txt|in)$/,
    /(^|\/)pyproject\.toml$/,
    /(^|\/)Pipfile$/,
    /(^|\/)setup\.py$/,
    /(^|\/)setup\.cfg$/,
  ],
  uv: [/(^|\/)uv\.lock$/, /(^|\/)pyproject\.toml$/, /(^|\/)requirements[^/]*\.txt$/],
  gomod: [/(^|\/)go\.mod$/],
  cargo: [/(^|\/)Cargo\.toml$/],
  docker: [
    /(^|\/)(dockerfile|containerfile)$/i,
    /(^|\/)(dockerfile|containerfile)[.-][^/]*$/i,
    /(^|\/)[^/]*\.(dockerfile|containerfile)$/i,
    /(^|\/)(docker-)?compose(\.[\w-]+)?\.ya?ml$/i,
  ],
  'docker-compose': [/(^|\/)(docker-)?compose(\.[\w-]+)?\.ya?ml$/i],
  'github-actions': [/(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/, /(^|\/)action\.ya?ml$/],
  bundler: [/(^|\/)Gemfile$/, /(^|\/)[^/]*\.gemspec$/],
  composer: [/(^|\/)composer\.json$/],
  maven: [/(^|\/)pom\.xml$/],
  gradle: [/(^|\/)build\.gradle(\.kts)?$/, /(^|\/)settings\.gradle(\.kts)?$/],
  nuget: [/(^|\/)[^/]*\.(csproj|fsproj|vbproj|props|targets)$/, /(^|\/)packages\.config$/],
  mix: [/(^|\/)mix\.exs$/],
  pub: [/(^|\/)pubspec\.yaml$/],
  swift: [/(^|\/)Package\.swift$/],
  terraform: [/(^|\/)[^/]*\.tf$/],
  opentofu: [/(^|\/)[^/]*\.tf$/],
  devcontainer: [/(^|\/)\.devcontainer\/devcontainer\.json$/],
  'pre-commit': [/(^|\/)\.pre-commit-config\.ya?ml$/],
  helm: [/(^|\/)Chart\.yaml$/],
  gitsubmodule: [/(^|\/)\.gitmodules$/],
  elm: [/(^|\/)elm\.json$/],
  julia: [/(^|\/)(Julia)?Project\.toml$/, /(^|\/)Manifest\.toml$/],
  nix: [/(^|\/)(flake|default|shell)\.nix$/],
  sbt: [/(^|\/)build\.sbt$/],
  vcpkg: [/(^|\/)vcpkg\.json$/],
  deno: [/(^|\/)deno\.(json|jsonc|lock)$/],
  conda: [/(^|\/)environment\.ya?ml$/, /(^|\/)meta\.yaml$/],
  'dotnet-sdk': [/(^|\/)global\.json$/],
  'rust-toolchain': [/(^|\/)rust-toolchain(\.toml)?$/],
  bazel: [/(^|\/)(MODULE\.bazel|WORKSPACE|WORKSPACE\.bazel)$/],
};

/** Ecosystems we are willing to call absent. */
export function hasDetector(ecosystem) {
  return Object.hasOwn(FILE_PATTERNS, ecosystem);
}

/** Display names of the files we look for, for finding text. */
export function detectorDescription(ecosystem) {
  const patterns = FILE_PATTERNS[ecosystem] ?? [];
  return patterns.map(describe).join(', ');
}

function describe(regex) {
  const text = regex.source;
  if (text.includes('dockerfile|containerfile')) return 'Dockerfile/Containerfile';
  if (text.includes('compose')) return 'docker-compose.yml';
  if (text.includes('requirements')) return 'requirements*.txt';
  if (text.includes('csproj')) return '*.csproj';
  if (text.includes('gemspec')) return 'Gemfile/*.gemspec';
  if (text.includes('\\.tf')) return '*.tf';
  if (text.includes('workflows')) return '.github/workflows/*.yml';
  if (text.includes('build\\.gradle')) return 'build.gradle';
  const literal = /\(\^\|\\\/\)([^$\\]+?)\$/.exec(text);
  if (literal) return literal[1].replace(/\\(.)/g, '$1');
  return text;
}

/** True when this single repo-relative path is a manifest for the ecosystem. */
export function isManifestFile(ecosystem, path) {
  const patterns = FILE_PATTERNS[ecosystem];
  if (!patterns) return false;
  const slashPath = path.startsWith('/') ? path : `/${path}`;
  return patterns.some((pattern) => pattern.test(slashPath));
}

/** True when any file under the given root-relative paths matches the detector. */
export function manifestPresent(ecosystem, files, directories) {
  const patterns = FILE_PATTERNS[ecosystem];
  if (!patterns) return false;
  const scope = directories.length === 0 ? ['/'] : directories;
  for (const file of files) {
    for (const directory of scope) {
      if (directory !== '/' && !file.startsWith(`${directory}/`)) continue;
      if (patterns.some((pattern) => pattern.test(file))) return true;
    }
  }
  return false;
}
