#!/usr/bin/env bash
# Usage: pr-automerge-hold.sh <owner/repo> <pr-number>
# Turns native auto-merge off when the PR's live labels include human:review.
# Only a live read counts: `gh pr create --label` adds labels after the PR
# opens, so the opened event's payload can miss them. Needs GH_TOKEN that may
# change the PR's auto-merge state.
set -euo pipefail

repo="$1" pr="$2"
state=$(gh pr view "$pr" --repo "$repo" --json labels,autoMergeRequest \
  --jq '[any(.labels[]; .name == "human:review"), .autoMergeRequest != null] | @tsv')

if [[ "$state" == $'true\ttrue' ]]; then
  gh pr merge "$pr" --repo "$repo" --disable-auto
  echo "::notice::#$pr carries human:review; auto-merge turned off."
fi
