#!/usr/bin/env bash
# Usage: pr-automerge-ready.sh <owner/repo> <base-branch>
# Prints "ready=true" when auto-merge may be armed on a PR into <base-branch>,
# else "ready=false" (a workflow warning goes to stderr). Ready means an active
# rule on the branch requires a "Merge Gate" status check (auto-merge waits
# only for checks an active rule requires) and the release App variable and key
# are set (APP_ID, HAS_KEY env). Needs GH_TOKEN with read access to the repo.
set -euo pipefail

# Reads the effective rules JSON on stdin; prints how many required contexts are a Merge Gate.
merge_gate_count() {
  jq '[.[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context
       | select(test("(^|/ )Merge Gate$"))] | length'
}

if [[ "${PR_AUTOMERGE_SELFTEST:-}" == 1 ]]; then
  merge_gate_count
  exit 0
fi

repo="$1" base="$2"
encoded_base=$(jq -rn --arg base "$base" '$base | @uri')
gated=$(gh api "repos/$repo/rules/branches/$encoded_base" | merge_gate_count)

if [[ "$gated" == 0 ]]; then
  echo "::warning::No active rule on $base requires a Merge Gate check; auto-merge not enabled." >&2
  echo "ready=false"
elif [[ -z "${APP_ID:-}" || "${HAS_KEY:-}" != true ]]; then
  echo "::warning::GH_ACTION_RELEASE_PLEASE_APP_ID or GH_ACTION_RELEASE_PLEASE_PRIVATE_KEY is not set; auto-merge not enabled." >&2
  echo "ready=false"
else
  echo "ready=true"
fi
