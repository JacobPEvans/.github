#!/usr/bin/env bash
# ci-gate-watchdog.sh — invoked by the `watchdog` job in _ci-gate.yml.
#
# After QUEUE_TIMEOUT_MINUTES, cancels every sibling job in the current
# workflow run that is still in `queued` state, except for "Queue Watchdog"
# (this script's own job) and "Merge Gate" (the gate job, which is still
# pending here because `needs: watchdog`). Cancellation forces a terminal
# state so `gate` can finally schedule and `re-actors/alls-green` can
# evaluate, ensuring the required `Merge Gate` status always reports.
#
# Required env:
#   GH_TOKEN              — GitHub token with actions:write on the run
#   QUEUE_TIMEOUT_MINUTES — minutes to wait before evaluating queued jobs
#   REPO                  — owner/repo of the current workflow run
#   RUN_ID                — workflow run id

set -euo pipefail

: "${GH_TOKEN:?required}"
: "${QUEUE_TIMEOUT_MINUTES:?required}"
: "${REPO:?required}"
: "${RUN_ID:?required}"

sleep "$((QUEUE_TIMEOUT_MINUTES * 60))"

# Names whose `status == "queued"` is intentional at this point in the run.
# The watchdog itself is mid-execution; the gate is awaiting watchdog.
exempt_filter='.name != "Queue Watchdog" and .name != "Merge Gate"'

stuck=$(gh api "repos/${REPO}/actions/runs/${RUN_ID}/jobs?per_page=100" \
  --jq ".jobs[] | select(.status == \"queued\" and ${exempt_filter}) | \"\(.id)\t\(.name)\"")

if [ -z "$stuck" ]; then
  echo "No stuck queued jobs found."
  exit 0
fi

while IFS=$'\t' read -r job_id job_name; do
  echo "Cancelling stuck queued job: ${job_name} (id=${job_id})"
  gh api -X POST "repos/${REPO}/actions/jobs/${job_id}/cancel" || true
done <<< "$stuck"
