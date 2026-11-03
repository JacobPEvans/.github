#!/usr/bin/env bash
# terrakube-gated-apply.sh — invoked by the `trigger` job in _converge.yml
# for target: terrakube-apply.
#
# Exchanges this job's own GitHub OIDC token for a Terrakube bearer token
# (Federated OIDC Authentication, org Security -> Federated Credentials —
# never OpenBao, which Terrakube has no integration to mint against),
# cancels any already-queued job for the workspace, plans from the working
# directory, creates a plan-and-apply job pinned to that plan's own upload,
# approves it only when the plan's own summary shows zero destroys, and
# waits for a terminal state. Terrakube has no native FIFO cancel for queued
# jobs (issues terrakube-io/terrakube#1957, #2850), so step 1 does it.
#
# Required env:
#   TERRAKUBE_API_ADDR             — e.g. https://terrakube-api.example.com
#   TERRAKUBE_ORG_ID                — organization UUID
#   TERRAKUBE_WORKSPACE_ID          — workspace UUID
#   TERRAKUBE_TEMPLATE_ID           — plan -> approval -> apply job template UUID
#   TERRAKUBE_TARGETED_TEMPLATE_ID  — required only when TARGET_ADDRS is set: the
#                                      plan -> approval -> apply (targeted) template UUID
#   TARGET_ADDRS                    — optional resource addresses, separated by
#                                      newlines or commas. Set and non-empty: the job
#                                      is created from TERRAKUBE_TARGETED_TEMPLATE_ID
#                                      with these as its targetAddrs. Unset or empty:
#                                      a whole-workspace job, as before. The zero-destroy
#                                      gate applies to targeted runs too.
#   INFRA_REPO                      — owner/repo of the infrastructure root, e.g.
#                                      dryvist/tofu-proxmox
#   ACTIONS_ID_TOKEN_REQUEST_TOKEN,
#   ACTIONS_ID_TOKEN_REQUEST_URL    — auto-injected by the runner when the job
#                                      has `permissions: id-token: write`; no
#                                      `env:` declaration needed in the caller
#   WAIT_MINUTES                    — bounded poll budget (default 10)
#
# Run from a checkout of the desired-state repository (the one carrying
# deployment.json and .infra-ref at its root) — this script reads
# .infra-ref, clones that ref of INFRA_REPO into a scratch directory,
# copies deployment.json into it, and plans from there.
set -euo pipefail

api() {
  # $1 method, $2 path (from $TERRAKUBE_API_ADDR), rest curl args
  local method=$1 path=$2
  shift 2
  curl -fsS --max-time 30 -X "$method" \
    -H "Authorization: Bearer ${TERRAKUBE_TOKEN}" \
    -H "Content-Type: application/vnd.api+json" \
    -H "Accept: application/vnd.api+json" \
    "${TERRAKUBE_API_ADDR%/}${path}" "$@"
}

# Exchanges this job's own GitHub OIDC token (audience "terrakube", matching
# the claim condition on the org's Federated Credential) for a Terrakube
# bearer token. Sets the global TERRAKUBE_TOKEN and masks it — masking must
# happen on the script's own real stdout, so this is called directly
# (never through command substitution, which would swallow the directive
# into the captured value instead of reaching the runner's log parser).
get_oidc_token() {
  local resp
  resp=$(curl -fsS --max-time 30 -H "Authorization: bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}" \
    "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=terrakube")
  TERRAKUBE_TOKEN=$(printf '%s' "$resp" | jq -r '.value')
  [[ -n $TERRAKUBE_TOKEN && $TERRAKUBE_TOKEN != null ]] || {
    echo "::error::failed to obtain a GitHub OIDC token for Terrakube"
    exit 1
  }
  echo "::add-mask::${TERRAKUBE_TOKEN}"
}

# Exports what `tofu`'s cloud-block CLI-driven workflow needs to run
# non-interactively, without a `tofu login`. tofu-proxmox's cloud block
# carries no hostname/organization/workspace by design (main.tf) — all
# three, plus the per-host credential, come from the environment:
#   - TF_WORKSPACE must be set explicitly: the stored default is a
#     DIFFERENT workspace and fails as a fake 403/401, not a wrong-
#     workspace error.
#   - TF_TOKEN_<host> follows Terraform's own convention: dots -> "_",
#     hyphens -> "__".
configure_tofu_cli_auth() {
  local org_name workspace_name tf_host tf_host_env
  org_name=$(api GET "/api/v1/organization/${TERRAKUBE_ORG_ID}" | jq -r '.data.attributes.name')
  workspace_name=$(api GET "/api/v1/organization/${TERRAKUBE_ORG_ID}/workspace/${TERRAKUBE_WORKSPACE_ID}" | jq -r '.data.attributes.name')
  [[ -n $org_name && $org_name != null ]] || { echo "::error::could not resolve organization ${TERRAKUBE_ORG_ID}'s name"; exit 1; }
  [[ -n $workspace_name && $workspace_name != null ]] || { echo "::error::could not resolve workspace ${TERRAKUBE_WORKSPACE_ID}'s name"; exit 1; }

  tf_host=$(printf '%s' "$TERRAKUBE_API_ADDR" | sed -E 's#^[a-zA-Z]+://##; s#/.*##')
  tf_host_env=$(printf '%s' "$tf_host" | sed -E 's/\./_/g; s/-/__/g')

  export TF_CLOUD_HOSTNAME="$tf_host"
  export TF_CLOUD_ORGANIZATION="$org_name"
  export TF_WORKSPACE="$workspace_name"
  export "TF_TOKEN_${tf_host_env}=${TERRAKUBE_TOKEN}"
}

# Cancels any job still `pending` or `waitingApproval` for the workspace, so
# an older push never applies after a newer one supersedes it.
cancel_queued_jobs() {
  local ids
  ids=$(api GET "/api/v1/organization/${TERRAKUBE_ORG_ID}/workspace/${TERRAKUBE_WORKSPACE_ID}/job" |
    jq -r '.data[] | select(.attributes.status == "pending" or .attributes.status == "waitingApproval") | .id')
  local id
  for id in $ids; do
    echo "cancelling queued job ${id}"
    api PATCH "/api/v1/organization/${TERRAKUBE_ORG_ID}/job/${id}" \
      -d "$(job_patch_body "$id" cancelled)" >/dev/null
  done
}

# Prints the job-creation body: pinned to $1 (a configuration-version
# terraformContent.tar.gz URL), using template $2, and carrying $3 as
# targetAddrs when $3 is a non-empty JSON array. Without $3 the body has no
# targetAddrs key.
build_job_body() {
  jq -n --arg t "$2" --arg src "$1" --arg ws "$TERRAKUBE_WORKSPACE_ID" --argjson targets "${3:-null}" '
    {data: {type: "job", attributes: {
      templateReference: $t,
      overrideBranch: "remote-content",
      overrideSource: $src
    }, relationships: {workspace: {data: {type: "workspace", id: $ws}}}}}
    | if $targets == null then . else .data.attributes.targetAddrs = $targets end'
}

# Prints TARGET_ADDRS as a compact JSON array of its non-empty, trimmed entries,
# split on newlines or commas. Prints nothing when TARGET_ADDRS is unset or empty.
targets_json() {
  [[ -n ${TARGET_ADDRS:-} ]] || return 0
  printf '%s\n' "$TARGET_ADDRS" | tr ',' '\n' |
    sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' |
    jq -R -c 'select(length > 0)' | jq -s -c .
}

# Creates the plan-and-apply job; arguments as build_job_body. Prints the new job id.
create_job() {
  local override_source=$1 template_id=$2 targets=${3:-}
  api POST "/api/v1/organization/${TERRAKUBE_ORG_ID}/job" -d "$(build_job_body "$override_source" "$template_id" "$targets")" |
    jq -r '.data.id'
}

# Polls job $1 until its Plan step has finished — status "waitingApproval"
# — or the job reaches a terminal state on its own (a plan failure never
# reaches approval). Prints whichever status it settles on, or "timeout".
# Reading the Plan step's log before this returns is the race the log-read
# used to have: right after create_job, the plan has not necessarily run
# yet, so the log request could hit an empty or stale output.
wait_for_plan() {
  local job_id=$1 elapsed=0 status
  while (( elapsed < WAIT_SECONDS )); do
    status=$(api GET "/api/v1/organization/${TERRAKUBE_ORG_ID}/job/${job_id}" | jq -r '.data.attributes.status')
    case "$status" in
      waitingApproval|completed|failed|cancelled|rejected|denied) echo "$status"; return ;;
    esac
    sleep 10
    elapsed=$((elapsed + 10))
  done
  echo "timeout"
}

# Reads job $1's Plan step output — call only once wait_for_plan reports
# waitingApproval, so the step has actually finished — and decides approve
# vs. park. Prints "approve" or "park: <summary line>". Strips ANSI colour
# codes before matching: the plan log is colourised.
gate_plan() {
  local job_id=$1
  local plan_step_id output log summary destroy
  # The job's `step` relationship lists step ids; the Plan step is
  # stepNumber 100 (fixed by the plan-and-apply template's tcl).
  plan_step_id=$(api GET "/api/v1/organization/${TERRAKUBE_ORG_ID}/job/${job_id}/step" |
    jq -r '.data[] | select(.attributes.stepNumber == 100) | .id')
  output=$(api GET "/api/v1/organization/${TERRAKUBE_ORG_ID}/job/${job_id}/step/${plan_step_id}" | jq -r '.data.attributes.output')
  log=$(curl -fsS --max-time 30 -H "Authorization: Bearer ${TERRAKUBE_TOKEN}" "$output" | sed -E 's/\x1b\[[0-9;]*[a-zA-Z]//g')
  summary=$(printf '%s\n' "$log" | grep -Eo 'Plan: [0-9]+ to add, [0-9]+ to change, [0-9]+ to destroy\.' | tail -1)
  if [[ -z $summary ]]; then
    # No changes at all reads as a clean, approvable no-op.
    if printf '%s\n' "$log" | grep -q 'No changes'; then
      echo "approve"
      return
    fi
    echo "park: could not find a plan summary line"
    return
  fi
  destroy=$(printf '%s\n' "$summary" | grep -Eo '[0-9]+ to destroy' | grep -Eo '^[0-9]+')
  if [[ $destroy -eq 0 ]]; then
    echo "approve"
  else
    echo "park: ${summary}"
  fi
}

# Clones INFRA_REPO@$1 (a release ref) into $2 (a fresh directory) and
# copies this checkout's deployment.json into its root. Asserts the copy
# matches the source byte-for-byte — that directory becomes the tarball
# `tofu plan` uploads, so this is checking the tarball's content, not a
# proxy for it.
assemble_tree() {
  local infra_ref=$1 tree_dir=$2
  git clone --quiet --depth 1 --branch "$infra_ref" \
    "https://github.com/${INFRA_REPO}.git" "$tree_dir"
  cp deployment.json "${tree_dir}/deployment.json"
  cmp -s deployment.json "${tree_dir}/deployment.json" || {
    echo "::error::deployment.json did not copy into the assembled tree unchanged"
    exit 1
  }
}

# Prints the JSON:API PATCH body that sets job $1 to status $2. The job id must
# be in the data object; the API rejects a PATCH without it.
job_patch_body() {
  jq -n --arg id "$1" --arg status "$2" '{data: {type: "job", id: $id, attributes: {status: $status}}}'
}

approve_job() {
  api PATCH "/api/v1/organization/${TERRAKUBE_ORG_ID}/job/$1" \
    -d "$(job_patch_body "$1" approved)" >/dev/null
}

# Polls job $1's status until it is one of the terminal states or
# $WAIT_SECONDS elapses. Prints the final status.
wait_for_terminal() {
  local job_id=$1 elapsed=0 status
  while (( elapsed < WAIT_SECONDS )); do
    status=$(api GET "/api/v1/organization/${TERRAKUBE_ORG_ID}/job/${job_id}" | jq -r '.data.attributes.status')
    case "$status" in
      completed|failed|cancelled|rejected|denied) echo "$status"; return ;;
    esac
    sleep 10
    elapsed=$((elapsed + 10))
  done
  echo "timeout"
}

main() {
  : "${TERRAKUBE_API_ADDR:?required}"
  : "${TERRAKUBE_ORG_ID:?required}"
  : "${TERRAKUBE_WORKSPACE_ID:?required}"
  : "${TERRAKUBE_TEMPLATE_ID:?required}"
  : "${INFRA_REPO:?required}"
  : "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:?required — the job needs permissions: id-token: write}"
  : "${ACTIONS_ID_TOKEN_REQUEST_URL:?required — the job needs permissions: id-token: write}"
  : "${WAIT_MINUTES:=10}"
  WAIT_SECONDS=$((WAIT_MINUTES * 60))

  local targets template_id=$TERRAKUBE_TEMPLATE_ID
  targets=$(targets_json)
  if [[ -n $targets ]]; then
    : "${TERRAKUBE_TARGETED_TEMPLATE_ID:?required when TARGET_ADDRS is set}"
    [[ $targets != '[]' ]] || { echo "::error::TARGET_ADDRS lists no resource addresses"; exit 1; }
    template_id=$TERRAKUBE_TARGETED_TEMPLATE_ID
    echo "targeted job, targetAddrs: ${targets}"
  fi

  [[ -f .infra-ref ]] || { echo "::error::.infra-ref not found in the desired-state repository root"; exit 1; }
  local infra_ref
  infra_ref=$(cat .infra-ref)

  get_oidc_token
  configure_tofu_cli_auth
  cancel_queued_jobs

  local tree_dir
  tree_dir=$(mktemp -d)
  assemble_tree "$infra_ref" "$tree_dir"

  # A plain `tofu plan` CLI run also creates a job, whose id is the run
  # number printed in its own URL; that job's own overrideSource already
  # carries the configuration-version tarball this script reuses below —
  # confirmed live (run 1025 -> job 1026: POSTing a new job with that
  # overrideSource worked).
  local plan_run_output
  plan_run_output=$(cd "$tree_dir" && tofu init -no-color && tofu plan -no-color 2>&1) || { echo "$plan_run_output"; exit 1; }
  local plan_job_id
  plan_job_id=$(printf '%s\n' "$plan_run_output" | grep -Eo '/runs/[A-Za-z0-9_-]+' | tail -1 | sed 's#/runs/##')
  [[ -n $plan_job_id ]] || { echo "::error::could not parse a run id from tofu plan's output"; exit 1; }
  local override_source
  override_source=$(api GET "/api/v1/organization/${TERRAKUBE_ORG_ID}/job/${plan_job_id}" | jq -r '.data.attributes.overrideSource')
  [[ -n $override_source && $override_source != null ]] || {
    echo "::error::job ${plan_job_id} has no overrideSource"
    exit 1
  }

  local job_id
  job_id=$(create_job "$override_source" "$template_id" "$targets")
  echo "created job ${job_id}"

  local plan_status
  plan_status=$(wait_for_plan "$job_id")
  case "$plan_status" in
    waitingApproval) : ;;
    timeout) echo "::error::job ${job_id} did not reach waitingApproval within ${WAIT_MINUTES}m"; exit 1 ;;
    *) echo "::error::job ${job_id} ended in ${plan_status} before reaching approval"; exit 1 ;;
  esac

  local decision
  decision=$(gate_plan "$job_id")
  local confirmation_url="${TERRAKUBE_API_ADDR}/api/v1/organization/${TERRAKUBE_ORG_ID}/job/${job_id}"
  if [[ $decision == approve ]]; then
    approve_job "$job_id"
  else
    echo "confirmation_url=${confirmation_url}" >>"${GITHUB_OUTPUT:-/dev/null}"
    # A parked job must not exit 0: nobody hears about a green run. The red
    # run IS the notification; report-and-close still closes the window
    # (its own `if:` runs on always()).
    echo "::error::parked: ${decision#park: } — ${confirmation_url}"
    exit 1
  fi

  local final_status
  final_status=$(wait_for_terminal "$job_id")
  echo "confirmation_url=${confirmation_url}" >>"${GITHUB_OUTPUT:-/dev/null}"
  [[ $final_status == completed ]] || { echo "::error::job ${job_id} ended in ${final_status}"; exit 1; }
  echo "job ${job_id} completed"
}

# --self-check: exercises gate_plan's, wait_for_plan's, and the job-body and
# TARGET_ADDRS logic against fixtures, without a runner or a real Terrakube.
if [[ ${1:-} == --self-check ]]; then
  fail=0
  export TERRAKUBE_ORG_ID=org1 TERRAKUBE_TOKEN=fake-token TERRAKUBE_WORKSPACE_ID=ws1

  check_gate() {
    local _fixture_log=$1 want=$2
    curl() { printf '%s' "$_fixture_log"; }
    api() {
      case "$2" in
        */step) echo '{"data":[{"id":"s1","attributes":{"stepNumber":100}}]}' ;;
        *) echo '{"data":{"attributes":{"output":"http://fixture"}}}' ;;
      esac
    }
    local got
    got=$(gate_plan job1)
    [[ $got == "$want"* ]] || { echo "FAIL: log=$_fixture_log -> got '$got', want prefix '$want'" >&2; fail=1; }
  }

  check_gate $'Plan: 2 to add, 0 to change, 0 to destroy.' "approve"
  check_gate $'Plan: 1 to add, 0 to change, 1 to destroy.' "park"
  check_gate $'No changes. Your infrastructure matches the configuration.' "approve"
  check_gate $'garbage, no plan summary here' "park"
  # A colourised log (the real 1026 log was) must strip before matching.
  check_gate $'\x1b[32mPlan: 2 to add, 0 to change, 0 to destroy.\x1b[0m' "approve"
  check_gate $'\x1b[1;31mPlan: 0 to add, 0 to change, 1 to destroy.\x1b[0m' "park"

  check_wait_for_plan() {
    local want=$1
    shift
    local -a seq=("$@")
    # A plain shell counter would not work here: wait_for_plan reads
    # status via `status=$(api ... | jq ...)`, a command substitution that
    # forks a subshell — any plain variable api() increments is a copy
    # discarded when that subshell exits. A file survives the fork.
    local counter_file
    counter_file=$(mktemp)
    echo 0 >"$counter_file"
    api() {
      local i s
      i=$(<"$counter_file")
      s=${seq[$i]}
      echo $((i + 1)) >"$counter_file"
      echo "{\"data\":{\"attributes\":{\"status\":\"$s\"}}}"
    }
    sleep() { :; } # no real waiting in a self-check
    # Exactly enough budget for one api() call per seq entry: the last
    # entry either returns a terminal status or the loop exhausts the
    # budget right after consuming it (the "timeout" case).
    WAIT_SECONDS=$((${#seq[@]} * 10))
    local got
    got=$(wait_for_plan job1)
    rm -f "$counter_file"
    [[ $got == "$want" ]] || { echo "FAIL: seq=${seq[*]} -> got '$got', want '$want'" >&2; fail=1; }
  }

  check_wait_for_plan waitingApproval pending waitingApproval
  check_wait_for_plan failed pending failed
  check_wait_for_plan timeout pending pending pending

  check_targets() {
    local target_env=$1 want=$2 got
    got=$(TARGET_ADDRS=$target_env targets_json)
    [[ $got == "$want" ]] || { echo "FAIL: TARGET_ADDRS=${target_env} -> got '${got}', want '${want}'" >&2; fail=1; }
  }

  check_job_body() {
    local target_env=$1 want=$2 got targets
    targets=$(TARGET_ADDRS=$target_env targets_json)
    got=$(build_job_body src1 tmpl1 "$targets" | jq -c .)
    [[ $got == "$want" ]] || { echo "FAIL: TARGET_ADDRS=${target_env} -> got '${got}', want '${want}'" >&2; fail=1; }
  }

  check_targets "" ""
  check_targets ' , ' '[]'
  check_targets $'module.a.x\n module.b.y, ' '["module.a.x","module.b.y"]'
  # Unset/empty TARGET_ADDRS: the body is exactly the whole-workspace body.
  check_job_body "" '{"data":{"type":"job","attributes":{"templateReference":"tmpl1","overrideBranch":"remote-content","overrideSource":"src1"},"relationships":{"workspace":{"data":{"type":"workspace","id":"ws1"}}}}}'
  check_job_body $'module.a.x\n module.b.y, ' '{"data":{"type":"job","attributes":{"templateReference":"tmpl1","overrideBranch":"remote-content","overrideSource":"src1","targetAddrs":["module.a.x","module.b.y"]},"relationships":{"workspace":{"data":{"type":"workspace","id":"ws1"}}}}}'

  # Each PATCH carries the job id in its data object, as a string. The stubbed
  # api records the body the real approve_job and cancel_queued_jobs send.
  check_patch_bodies() {
    local patch_body=
    api() {
      if [[ $1 == PATCH ]]; then
        patch_body=$4
      else
        echo '{"data":[{"id":"1026","attributes":{"status":"pending"}}]}'
      fi
    }
    local got
    approve_job 1026 >/dev/null
    got=$(printf '%s' "$patch_body" | jq -c .)
    [[ $got == '{"data":{"type":"job","id":"1026","attributes":{"status":"approved"}}}' ]] || { echo "FAIL: approve body '${got}'" >&2; fail=1; }
    cancel_queued_jobs >/dev/null
    got=$(printf '%s' "$patch_body" | jq -c .)
    [[ $got == '{"data":{"type":"job","id":"1026","attributes":{"status":"cancelled"}}}' ]] || { echo "FAIL: cancel body '${got}'" >&2; fail=1; }
  }
  check_patch_bodies

  [[ $fail == 0 ]] && echo "self-check OK: 16 cases"
  exit $fail
fi

main "$@"
