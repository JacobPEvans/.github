#!/usr/bin/env bash
# Cancel the queued and in-progress pull request runs on a closed PR's head branch.
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

# Only runs a pull request event started: a push or workflow_dispatch run on the same branch (develop, for a
# promotion PR) is not the PR's run.
runs=$(gh run list --repo "$repo" --branch "$branch" --limit 1000 --json databaseId,status,event \
  --jq '.[] | select(.status == "queued" or .status == "in_progress") | select(.event | startswith("pull_request")) | .databaseId')

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
