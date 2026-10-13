#!/usr/bin/env bash
set -euo pipefail

: "$GH_TOKEN"
: "$GH_REPO"

prs=$(gh pr list --repo "$GH_REPO" --state merged --label "autorelease: pending" \
  --base develop --limit 1000 --json number,mergeCommit)
rows=$(jq -r '.[] | [.number, .mergeCommit.oid] | @tsv' <<< "$prs")
safe=true

while IFS=$'\t' read -r number sha; do
  [[ -n "$number" ]] || continue
  status=$(gh api "repos/$GH_REPO/compare/$sha...main" --jq .status)
  printf 'PR #%s sha=%s status=%s\n' "$number" "$sha" "$status"
  case "$status" in
    ahead|identical) ;;
    *) safe=false ;;
  esac
done <<< "$rows"

printf 'safe=%s\n' "$safe"
