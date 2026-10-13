#!/usr/bin/env bash
# Per-PR policy for the bot PR automerge sweep. Reads one `gh pr view --json` object on
# stdin plus REPO (owner/name) and prints `proceed` or `skip:<reason>`.
#
# A PR from SMALL_DIFF_PROJECTION_AUTHOR proceeds only in SMALL_DIFF_PROJECTION_REPO, with
# at most SMALL_DIFF_MAX_FILES changed files and SMALL_DIFF_MAX_LINES added plus deleted
# lines, a complete changed-file list, and no path under .github/workflows/ or matching a
# secrets, credentials, auth, permissions, .env, .pem or .key rule. Every other author
# proceeds to the sweep's remaining gates.
set -euo pipefail

if ! pr=$(jq -c -s '
  if length == 1 and (.[0] | type) == "object" then .[0]
  else error("expected one PR object")
  end
' 2>/dev/null); then
  echo "expected exactly one PR JSON object on stdin" >&2
  exit 2
fi

author=$(jq -r '.author.login // ""' <<<"$pr")
projection_author=${SMALL_DIFF_PROJECTION_AUTHOR:-app/openbao-service-broker}
projection_repo=${SMALL_DIFF_PROJECTION_REPO:-dryvist/docs}
repo=${REPO:-}
result=proceed

if [[ "$author" == "$projection_author" ]]; then
  if [[ "$repo" != "$projection_repo" ]]; then
    result=skip:author-not-allowed-here
  else
    max_files=${SMALL_DIFF_MAX_FILES:-5}
    max_lines=${SMALL_DIFF_MAX_LINES:-100}
    if [[ ! "$max_files" =~ ^(0|[1-9][0-9]*)$ || ! "$max_lines" =~ ^(0|[1-9][0-9]*)$ ]]; then
      result=skip:size-unverifiable
    else
      shape=$(jq -r '
        if (.changedFiles | type) != "number"
          or (.additions | type) != "number"
          or (.deletions | type) != "number"
          or (.files | type) != "array"
          or any(.files[]; (.path | type) != "string")
        then "invalid"
        else "valid"
        end
      ' <<<"$pr")
      if [[ "$shape" != valid ]]; then
        result=skip:size-unverifiable
      else
        size_policy=$(jq -r --argjson max_files "$max_files" --argjson max_lines "$max_lines" '
          if .changedFiles != (.files | length) then "size-unverifiable"
          elif .changedFiles > $max_files or (.additions + .deletions) > $max_lines then "too-large"
          elif any(.files[].path;
            startswith(".github/workflows/")
            or test("(^|/)(secrets?|credentials?|auth|permissions?|\\.env)([./_-]|$)"; "i")
            or test("\\.(pem|key)$"; "i")
          ) then "sensitive-path"
          else "proceed"
          end
        ' <<<"$pr")
        [[ "$size_policy" == proceed ]] || result="skip:$size_policy"
      fi
    fi
  fi
fi

printf '%s\n' "$result"
