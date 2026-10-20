#!/usr/bin/env bash
# Run pip-audit against each project directory, optionally suppressing
# specific vulnerability IDs (transitive deps with no upstream fix).
#
# Inputs (env):
#   PYTHON_DIRS    space-separated project paths (relative to GITHUB_WORKSPACE)
#   IGNORE_VULNS   space-separated CVE / GHSA / PYSEC IDs to skip (optional)
#
# Used by: .github/workflows/_python-security.yml
set -euo pipefail

ignore_args=()
if [[ -n "${IGNORE_VULNS:-}" ]]; then
  for vuln in $IGNORE_VULNS; do
    ignore_args+=(--ignore-vuln "$vuln")
  done
fi

for dir in $PYTHON_DIRS; do
  (
    echo "::group::Scanning $dir"
    trap 'echo "::endgroup::"' EXIT
    cd "$GITHUB_WORKSPACE/$dir"
    # A directory of bare scripts declares no dependencies, so there is nothing to audit.
    if [[ ! -f pyproject.toml ]]; then
      echo "::notice::$dir has no pyproject.toml; no dependencies to audit"
      exit 0
    fi
    # Sync lock file in case pyproject.toml version was bumped (e.g. by
    # release-please) without a corresponding `uv lock` run. This is a
    # no-op when the lock file is already up to date.
    uv lock
    # --no-emit-project avoids exporting the local project as an editable
    # requirement when hashes are present, which would cause pip / pip-audit
    # to fail with "editable requirement cannot be installed when requiring
    # hashes".
    uv export --format requirements-txt --output-file requirements.txt --locked --no-emit-project
    # --disable-pip audits the hash-pinned export as written instead of
    # installing it into a venv, so the runner's Python and platform need
    # no wheel for each package (macOS-only wheels such as mlx). --no-deps
    # is required for a project with no dependencies, whose empty export
    # carries no hashes; the lock already lists every transitive package.
    uvx pip-audit --progress-spinner=off --desc --disable-pip --no-deps "${ignore_args[@]}" -r requirements.txt
  )
done
