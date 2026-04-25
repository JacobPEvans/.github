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

IGNORE_FLAGS=""
if [[ -n "${IGNORE_VULNS:-}" ]]; then
  for vuln in $IGNORE_VULNS; do
    IGNORE_FLAGS+=" --ignore-vuln $vuln"
  done
fi

for dir in $PYTHON_DIRS; do
  echo "::group::Scanning $dir"
  cd "$GITHUB_WORKSPACE/$dir"
  # --no-emit-project avoids exporting the local project as an editable requirement when
  # hashes are present, which would cause pip / pip-audit to fail with
  # "editable requirement cannot be installed when requiring hashes".
  uv export --format requirements-txt --output-file requirements.txt --locked --no-emit-project
  # shellcheck disable=SC2086 # word splitting is intentional for IGNORE_FLAGS
  uvx pip-audit --progress-spinner=off --desc $IGNORE_FLAGS -r requirements.txt
  echo "::endgroup::"
done
