# The lane decision table, shared by .github/workflows/_lane.yml (which feeds
# it event data gathered in the workflow step) and tests/lane.test.js (which
# feeds it the table cases). One program, one decision, so the workflow and
# the tests cannot drift apart.
#
# Input (JSON object):
#   event_name        pull_request | merge_group | push | any other event
#   repository        full name of the repository the gate runs in
#   author            pull request author login, "" when the event has none
#   head_ref          pull request head branch, "" when unknown
#   head_repo         pull request head repository full name, "" when unknown
#   labels            array of pull request label names
#   additions         number of added lines, null when the count is unknown
#   deletions         number of deleted lines, null when the count is unknown
#   changed_paths     every changed path (paths-filter's changed_all_files)
#   low_risk_paths    changed paths that matched the low_risk filter
#   instruction_paths changed paths that matched the instruction filter
#   guarded_paths     changed paths that matched the guarded filter
#   bot_logins        logins that always take the bot lane
#   automation_logins logins that take the bot lane with the auto-revert label
#   sandbox_logins    sandbox executor logins, never tiny or land-first
#   tier              merge_tier of the repository; absent means legacy
#
# Output (JSON object): lane, heavy_jobs, fast_path, tiny. The three flags
# are "true"/"false" strings, ready for GITHUB_OUTPUT.
. as $in |
def is_fork:
  (($in.event_name == "pull_request") or ($in.event_name == "merge_group"))
  and (($in.head_repo // "") != $in.repository);
def is_sandbox:
  (($in.sandbox_logins | index($in.author)) != null)
  or (($in.head_ref // "") | startswith("agent/"));
def is_bot:
  (($in.bot_logins | index($in.author)) != null)
  or ((($in.automation_logins | index($in.author)) != null)
      and (($in.labels | index("auto-revert")) != null));
def guarded_changed:
  (($in.guarded_paths // []) | length > 0);
def instruction_changed:
  (($in.instruction_paths // []) | length > 0);
# A change is all low-risk when the file list is known and every changed
# path matched the low_risk filter.
def only_low_risk:
  (($in.changed_paths // []) | length > 0)
  and ((($in.changed_paths // []) - ($in.low_risk_paths // [])) | length == 0);
def lines_changed:
  (($in.additions // 0) + ($in.deletions // 0));
def counts_known:
  (($in.additions | type) == "number") and (($in.deletions | type) == "number");
# The tiny and land-first lanes defer heavy checks to the post-merge workflow,
# which only standard and hot repositories call. A legacy repository never
# takes them.
def may_go_light:
  ((is_fork or is_sandbox) | not) and (($in.tier // "legacy") != "legacy");
def tiny_lane:
  counts_known and (lines_changed <= 10) and only_low_risk
  and (instruction_changed | not) and may_go_light;
def land_first_lane:
  (($in.labels | index("land-first")) != null) and may_go_light;
(if guarded_changed then "guarded"
elif is_bot then "bot"
elif tiny_lane then "tiny"
elif land_first_lane then "land-first"
else "normal" end) as $lane |
{
  lane: $lane,
  # Heavy jobs run for the normal, guarded and bot lanes (each still mapped
  # to the changed paths by its own filter) and skip for the tiny and
  # land-first lanes. fast_path is the legacy alias callers gate with
  # `fast_path != 'true'`.
  heavy_jobs: (if $lane == "tiny" or $lane == "land-first" then "false" else "true" end),
  fast_path: (if $lane == "tiny" or $lane == "land-first" then "true" else "false" end),
  tiny: (if $lane == "tiny" then "true" else "false" end)
}
