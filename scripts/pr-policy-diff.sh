#!/usr/bin/env bash
# Writes the PR's unified diff to $1 and exits 0, or exits 1 when no complete diff is available.
# Env: REPO, PR, CHANGED_FILES, GH_TOKEN.
set -uo pipefail
out=$1
policy_file='^\.github/workflows/.*\.ya?ml$|(^|/)action\.ya?ml$'

if gh api -H 'Accept: application/vnd.github.diff' "repos/$REPO/pulls/$PR" > "$out"; then
  exit 0
fi

# Past the diff endpoint's 300-file cap, rebuild the diff from per-file patches (listed up to 3000
# files). A workflow or action file without a patch means the diff is incomplete.
files="$out.files.json"
[ "$CHANGED_FILES" -le 3000 ] || exit 1
gh api --paginate "repos/$REPO/pulls/$PR/files?per_page=100" > "$files" || exit 1
jq -e -s --arg re "$policy_file" 'add | all(.[]; (.filename | test($re) | not) or .patch != null)' \
  "$files" > /dev/null || exit 1
jq -r -s 'add[] | "+++ b/\(.filename)\n\(.patch // "")"' "$files" > "$out"
