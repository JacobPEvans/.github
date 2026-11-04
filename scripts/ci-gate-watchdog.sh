#!/usr/bin/env bash
# ci-gate-watchdog.sh — invoked by the `watchdog` job in _ci-gate.yml.
#
# Watch the run's sibling jobs for the whole run. Cancel the run if any job still
# waiting for a runner (`queued`, `pending` or `requested`) is older than
# QUEUE_TIMEOUT_MINUTES, measured per job from its created_at. Exit 0 once every
# sibling is `completed`. The Actions API does not expose job cancellation;
# cancelling the run keeps an incomplete check set from passing.
#
# The watchdog no longer exits at the first moment nothing is queued: jobs created
# later in the run (matrix legs, called workflows) and jobs reported as `pending`
# would go unwatched. It therefore lives as long as the run. On GitHub-hosted
# runners siblings finish in minutes, so it still exits as soon as the last one
# completes. `waiting` (environment approval) is not a runner queue and is never
# cancelled, but it keeps the watchdog polling until the job's timeout-minutes
# ceiling. "Queue Watchdog" (this job) and "Merge Gate" (awaiting this job) are
# exempt; their state here is intentional. Inside a called workflow GitHub
# prefixes job names ("nix / Merge Gate"), so the exemption matches the last
# " / " segment, which also exempts sibling watchdogs from other gate calls.
#
# Required env:
#   GH_TOKEN              — GitHub token with actions:write on the run
#   QUEUE_TIMEOUT_MINUTES — minutes a job may wait for a runner before the run is cancelled
#   REPO                  — owner/repo of the current workflow run
#   RUN_ID                — workflow run id
# Optional env:
#   WATCH_MAX_MINUTES     — minutes after which the watchdog stops watching and exits 0
#                           (default 55; keep it below the job's timeout-minutes)

set -euo pipefail

: "${GH_TOKEN:?required}"
: "${QUEUE_TIMEOUT_MINUTES:?required}"
: "${REPO:?required}"
: "${RUN_ID:?required}"

# One line per non-exempt sibling: id, status, whole seconds since created_at, name.
# gh evaluates --jq itself (gojq, which has now and fromdateiso8601), so the runner
# needs no jq binary.
sibling_jobs() {
  gh api --paginate "repos/${REPO}/actions/runs/${RUN_ID}/jobs?per_page=100" \
    --jq '.jobs[]
      | select(.name | test("(^| / )(Queue Watchdog|Merge Gate)$") | not)
      | "\(.id)\t\(.status)\t\(now - (.created_at | fromdateiso8601) | floor)\t\(.name)"'
}

# awk parses QUEUE_TIMEOUT_MINUTES so a float (e.g. 0.5) truncates to an integer
# instead of crashing bash arithmetic, which only handles integers.
limit_seconds=$(awk "BEGIN{printf \"%d\", $QUEUE_TIMEOUT_MINUTES * 60}")
poll_interval=10
# Stop watching before the job's own timeout-minutes, so a long healthy run never
# turns the watchdog red. $SECONDS is bash's elapsed-time builtin.
watch_seconds=$(awk "BEGIN{printf \"%d\", ${WATCH_MAX_MINUTES:-55} * 60}")
WATCH_MAX_MINUTES=${WATCH_MAX_MINUTES:-55}

while :; do
  jobs=$(sibling_jobs)
  stuck=$(awk -F'\t' -v max="$limit_seconds" \
    '$2 ~ /^(queued|pending|requested)$/ && $3 > max' <<<"$jobs")
  if [ -n "$stuck" ]; then
    echo "Timeout (${QUEUE_TIMEOUT_MINUTES}m) reached; cancelling jobs still waiting for a runner:"
    break
  fi
  unfinished=$(awk -F'\t' 'NF && $2 != "completed" { n++ } END { print n + 0 }' <<<"$jobs")
  if [ "$unfinished" -eq 0 ]; then
    echo "All sibling jobs completed. Nothing to cancel."
    exit 0
  fi
  if [ "$SECONDS" -ge "$watch_seconds" ]; then
    echo "::notice::Queue Watchdog stopped watching after ${WATCH_MAX_MINUTES}m; no job had waited for a runner longer than ${QUEUE_TIMEOUT_MINUTES}m."
    exit 0
  fi
  sleep "$poll_interval"
done

while IFS=$'\t' read -r _ status age job_name; do
  echo "Stuck job: ${job_name} (${status}, ${age}s since created)"
done <<<"$stuck"

echo "Cancelling workflow run ${RUN_ID}; jobs waiting for a runner prevent a complete check set."
gh api -X POST "repos/${REPO}/actions/runs/${RUN_ID}/cancel"
