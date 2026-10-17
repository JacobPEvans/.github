#!/usr/bin/env bash
# Fails when a caller workflow's `uses:` names a reusable workflow or local
# path that does not exist.
#   ./.github/workflows/<file>            must exist in the checked-out repo
#   JacobPEvans/.github or JacobPEvans/.github-ai, .github/workflows/<file>@<ref>
#                                         must exist at <ref>, read via the API
# Other `uses:` values are not checked: other dryvist repos may be private,
# and this run's token cannot read them, so a valid ref would false-fail.
# Other dryvist refs print a notice instead, and actions are ignored.
# actionlint does not resolve either form, so this check is the enforcement.
#
# Pin policy, checked on every dryvist reference in the checked-out repo
# (`uses:` refs are checked by pr-policy.yml):
#   flake.nix                github:dryvist/... input        carries ?ref=v<major>
#   .envrc                   no `use flake` of a remote dryvist flake
#   requirements.yml         dryvist git source              version is not main, develop or HEAD
# warn mode: each finding is a ::warning annotation and the script exits 0.
# fail mode: each finding is an ::error annotation and the script exits 1.
#
# Environment:
#   GH_TOKEN         token for `gh api` (dryvist remote refs only)
#   PIN_POLICY_MODE  fail (default) or warn
set -euo pipefail

mode=${PIN_POLICY_MODE:-fail}
case "$mode" in
  warn | fail) ;;
  *)
    echo "::error::PIN_POLICY_MODE must be warn or fail, not '${mode}'"
    exit 2
    ;;
esac

errors=0
findings=0

fail() {
  echo "::error file=${1}::${1} calls ${2}, which does not resolve (${3})"
  errors=$((errors + 1))
}

# One pin-policy finding: a warning in warn mode, an error in fail mode.
policy() {
  local level=warning
  findings=$((findings + 1))
  if [ "$mode" = fail ]; then level=error; fi
  echo "::${level} file=${1},line=${2}::${3}"
}

# Files with the given name, skipping VCS, worktree and dependency trees.
find_named() {
  find . \( -name .git -o -name .worktrees -o -name node_modules \) -prune -o -name "$1" -print
}

shopt -s nullglob
uses_files=(.github/workflows/*.yml .github/workflows/*.yaml)
while IFS= read -r action; do
  uses_files+=("${action#./}")
done < <(find_named action.yml; find_named action.yaml)
# A `uses` key as a block entry, a flow-style entry (`{uses: ...}`, `, uses: ...`) or a quoted key.
uses_key='(^|[[:space:]{,"'\''])uses["'\'']?[[:space:]]*:'
for wf in ${uses_files[@]+"${uses_files[@]}"}; do
  while IFS= read -r hit; do
    lineno=${hit%%:*}
    line=${hit#*:}
    line=$(printf '%s' "$line" | tr -d "\"'{}")
    value=${line#*uses:}
    value=${value%%#*}
    value=${value%%,*}
    value=$(printf '%s' "$value" | tr -d " \t")
    # The org name is matched without case; the original text is kept for messages.
    lower=$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')

    case "$lower" in
      ./.github/workflows/*)
        if [[ ! -f "${value#./}" ]]; then
          fail "$wf" "$value" "local file missing"
        fi
        ;;
      dryvist/*/.github/workflows/*@* | jacobpevans/*/.github/workflows/*@*)
        owner=${value%%/*}
        rest=${value#*/}
        repo=${rest%%/*}
        if [[ "$repo" != ".github" && "$repo" != ".github-ai" && "$repo" != "ai-workflows" ]]; then
          echo "::notice::not checked (${value})"
          continue
        fi
        rest=${rest#*/}
        file=${rest%@*}
        ref=${value##*@}
        file=${file#.github/workflows/}
        if ! gh api --method HEAD \
          "repos/${owner}/${repo}/contents/.github/workflows/${file}?ref=${ref}" \
          >/dev/null 2>&1; then
          fail "$wf" "$value" "not found at ref, or not readable with this token"
        fi
        ;;
    esac
  done < <({ grep -nE "$uses_key" "$wf" || true; } | { grep -vE '^[0-9]+:[[:space:]]*#' || true; })
done

# A flake input is pinned when its ref is a floating major tag (v<digits>) or an exact
# release tag (v<digits>.<digits>.<digits>), which a producer that cannot carry a floating
# tag (an archived repository) uses. A branch, or no ref at all, is not a pin.
flake_ref='ref=v[0-9]+(\.[0-9]+\.[0-9]+)?([^.0-9A-Za-z_-]|$)'
while IFS= read -r file; do
  file=${file#./}
  while IFS= read -r hit; do
    lineno=${hit%%:*}
    text=${hit#*:}
    stripped=${text#"${text%%[![:space:]]*}"}
    case "$stripped" in
      '#'*) continue ;;
    esac
    if [[ ! $text =~ $flake_ref ]]; then
      policy "$file" "$lineno" "dryvist flake input has no ?ref=v<major> (or an exact release tag)"
    fi
  done < <(grep -nE 'github:(dryvist|JacobPEvans)/|git[+][a-z]+://(git@)?github[.]com/(dryvist|JacobPEvans)/' "$file" || true)
done < <(find_named flake.nix)

# `use flake` of a remote flake whose address names the dryvist org, or the legacy
# JacobPEvans owner that redirects to it.
envrc_remote='^[[:space:]]*use[[:space:]]+flake[[:space:]]+["'\'']?[a-zA-Z+]+[:@][^[:space:]]*(dryvist|JacobPEvans)/'
while IFS= read -r file; do
  file=${file#./}
  while IFS= read -r hit; do
    policy "$file" "${hit%%:*}" "use flake loads a remote dryvist flake"
  done < <(grep -nE "$envrc_remote" "$file" || true)
done < <(find_named .envrc)

# A dryvist git source (a remote URL naming dryvist/) whose version is a branch.
# The version is the key on the source's own list entry, or the comma suffix of
# a bare `url,version` entry.
while IFS= read -r file; do
  file=${file#./}
  while IFS=$'\t' read -r lineno version; do
    policy "$file" "$lineno" "dryvist git source pinned to branch ${version}; pin a release version"
  done < <(awk '
    function flush() {
      if (src && (ver == "main" || ver == "develop" || ver == "head")) {
        printf "%d\t%s\n", vline, ver
      }
    }
    /^[[:space:]]*-/ { flush(); src = 0; ver = ""; vline = NR }
    index($0, "dryvist/") && $0 ~ /git[+]|:\/\/|git@|github[.]com/ {
      src = 1
      if ($0 ~ /,[[:space:]]*[A-Za-z]+[[:space:]]*$/) {
        v = $0
        sub(/.*,[[:space:]]*/, "", v)
        sub(/[[:space:]]+$/, "", v)
        ver = tolower(v)
        vline = NR
      }
    }
    /^[[:space:]]*(-[[:space:]]+)?version:/ {
      v = $0
      sub(/^[[:space:]]*(-[[:space:]]+)?version:[[:space:]]*/, "", v)
      gsub(/"/, "", v)
      gsub(sprintf("%c", 39), "", v)
      sub(/[[:space:]]*#.*$/, "", v)
      sub(/[[:space:]]+$/, "", v)
      ver = tolower(v)
      vline = NR
    }
    END { flush() }
  ' "$file")
done < <(find_named requirements.yml)

if [[ "$errors" -gt 0 ]]; then
  echo "uses resolve check: ${errors} unresolved reference(s)"
  exit 1
fi
if [[ "$findings" -gt 0 ]]; then
  echo "pin policy ${mode}: ${findings} finding(s)"
  if [[ "$mode" = fail ]]; then
    exit 1
  fi
fi
echo "uses resolve check: all reusable workflow references resolve"
