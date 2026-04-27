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
    # Sync lock file in case pyproject.toml version was bumped (e.g. by
    # release-please) without a corresponding `uv lock` run. This is a
    # no-op when the lock file is already up to date.
    uv lock
    # --no-emit-project avoids exporting the local project as an editable
    # requirement when hashes are present, which would cause pip / pip-audit
    # to fail with "editable requirement cannot be installed when requiring
    # hashes".
    uv export --format requirements-txt --output-file requirements.txt --locked --no-emit-project
    uvx pip-audit --progress-spinner=off --desc "${ignore_args[@]}" -r requirements.txt
  )
done
