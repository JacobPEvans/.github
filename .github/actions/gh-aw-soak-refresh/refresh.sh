#!/usr/bin/env bash
# Refresh gh-aw action SHA pins with a 24h supply-chain soak.
#
# 1. Snapshot HEAD's lock file (the "before" state).
# 2. Force-refresh all pins to current upstream SHAs.
# 3. For each entry whose SHA changed AND the new SHA's commit is <24h
#    old, rewind that entry's SHA to its predecessor in the lock file.
#    The `version` field is left unchanged; the lock file stays consistent.
# 4. Re-emit .lock.yml files via a no-flag `gh aw compile`.
#
# First-time pins (no predecessor in HEAD's lock file) skip the rewind
# and adopt the fresh SHA -- recurring refreshes never encounter this.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LOCK=.github/aw/actions-lock.json
BEFORE=$(mktemp)
trap 'rm -f "$BEFORE"' EXIT

git show "HEAD:$LOCK" >"$BEFORE" 2>/dev/null || echo '{"entries":{}}' >"$BEFORE"

gh aw compile --force-refresh-action-pins

NOW=$(date -u +%s)

while IFS='|' read -r key repo new_sha old_sha; do
  d=$(gh api "repos/$repo/commits/$new_sha" --jq .commit.committer.date 2>/dev/null) || continue
  age_h=$(((NOW - $(date -d "$d" +%s)) / 3600))
  if [ "$age_h" -lt 24 ]; then
    tmp=$(mktemp)
    jq --arg k "$key" --arg s "$old_sha" '.entries[$k].sha = $s' "$LOCK" >"$tmp"
    mv "$tmp" "$LOCK"
    echo "rewound: $key  $new_sha -> $old_sha  (commit was ${age_h}h old)"
  fi
done < <(jq -r --slurpfile b "$BEFORE" -f "$SCRIPT_DIR/diff-changed-pins.jq" "$LOCK")

gh aw compile
