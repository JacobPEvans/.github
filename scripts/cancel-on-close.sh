#!/usr/bin/env bash
# Cancel the queued and in-progress workflow runs on a closed PR's head branch.
#
# Called by the reusable _cancel-on-close.yml from a `pull_request: closed` run.
#
# Usage: cancel-on-close.sh <head-branch>
# Env:   REPO     owner/name of the repository (required)
#        GH_TOKEN token with actions:write (read by gh)
#        RUN_ID   the run executing this script; it is never cancelled (optional)
#
# A run that is already gone (HTTP 404, or gh's "could not find any workflow run")
# or already completed counts as cancelled.
# Any other error fails the script.
set -euo pipefail

branch=${1:?usage: cancel-on-close.sh <head-branch>}
repo=${REPO:?REPO is required}
keep=${RUN_ID:-}

runs=$(gh run list --repo "$repo" --branch "$branch" --limit 1000 --json databaseId,status \
  --jq '.[] | select(.status == "queued" or .status == "in_progress") | .databaseId')

while read -r id; do
  [ -n "$id" ] || continue
  [ "$id" = "$keep" ] && continue
  if err=$(gh run cancel "$id" --repo "$repo" 2>&1); then
    echo "cancelled run $id"
  elif grep -qiE 'HTTP 404|could not find any workflow run|already completed|that is completed' <<<"$err"; then
    echo "::notice::run $id is already gone or completed; treated as cancelled"
  else
    echo "$err" >&2
    exit 1
  fi
done <<<"$runs"
