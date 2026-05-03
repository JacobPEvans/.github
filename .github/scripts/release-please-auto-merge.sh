#!/usr/bin/env bash
# Enables auto-merge on the open release-please Release PR once it has
# been idle (no new commits) for at least QUIET_SECONDS seconds.
#
# Required env vars (set by the calling workflow step's env: block):
#   GH_TOKEN        - GitHub token with contents:write + pull-requests:write
#   GITHUB_REPOSITORY - owner/repo of the target repository
#   BASE_BRANCH     - base branch whose release PR to check
#   QUIET_SECONDS   - minimum idle seconds before enabling auto-merge
#   MERGE_METHOD    - squash | merge | rebase
set -euo pipefail

case "$MERGE_METHOD" in
  squash|merge|rebase) ;;
  *) echo "Invalid merge-method: $MERGE_METHOD"; exit 1 ;;
esac

PR=$(gh pr list \
  --repo "$GITHUB_REPOSITORY" \
  --head "release-please--branches--${BASE_BRANCH}" \
  --state open \
  --json number,updatedAt,labels \
  --jq '.[0] // empty')

[ -z "$PR" ] && { echo "No open release PR found."; exit 0; }

PR_NUMBER=$(echo "$PR" | jq -r '.number')
UPDATED_AT=$(echo "$PR" | jq -r '.updatedAt')

if echo "$PR" | jq -e '.labels[].name | select(. == "do-not-merge" or . == "hold")' > /dev/null 2>&1; then
  echo "Release PR #${PR_NUMBER} has a hold label -- skipping."
  exit 0
fi

NOW=$(date +%s)
UPDATED=$(date -d "$UPDATED_AT" +%s 2>/dev/null || date -j -f "%Y-%m-%dT%H:%M:%SZ" "$UPDATED_AT" +%s)
IDLE=$(( NOW - UPDATED ))

echo "Release PR #${PR_NUMBER} idle for ${IDLE}s (threshold: ${QUIET_SECONDS}s)."
[ "$IDLE" -lt "$QUIET_SECONDS" ] && { echo "Not quiet yet -- skipping."; exit 0; }

# Disable+re-enable handles stale auto-merge queue (RC3).
# Retry loop handles transient GraphQL errors (RC2).
gh pr merge "$PR_NUMBER" --repo "$GITHUB_REPOSITORY" --disable-auto 2>/dev/null || true
for _ in 1 2 3; do
  gh pr merge "$PR_NUMBER" --repo "$GITHUB_REPOSITORY" --auto "--${MERGE_METHOD}" && exit 0
  sleep 15
done
exit 1
