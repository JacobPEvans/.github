#!/usr/bin/env bash
# Renovate annotation gate — fails when a version pin sits in a path the
# Renovate preset's annotated-pin customManagers cover (renovate-presets.json
# "Renovate-annotated version pins in Ansible role defaults") but carries no
# `# renovate: datasource=... depName=...` comment above it. An unannotated
# pin in these paths is invisible to Renovate and rots silently — see
# renovate-audit gap #1/#4 (docs.jacobpevans.com/conventions/dependency-automation).
#
# `_image:` keys are exempt: the separate no-annotation docker-image
# customManager already tracks those by pattern, no annotation needed.
#
# Escape hatch: a pin that is deliberately NOT a Renovate-trackable
# dependency (a PVE-host expected-version guard, an ISO/template name with
# no public datasource) satisfies this checker with a bare
# `# renovate: ignore — <reason>` comment. The checker requires the FULL
# `datasource=... depName=...[ versioning=...]` shape or a bare `ignore`
# (not just a `# renovate:` prefix — a typo like `datasorce=` or a double
# space after the colon used to still pass a prefix-only check while
# matching no real renovate-presets.json matchString, so the pin stayed
# silently untracked despite green CI); the preset's own matchStrings
# additionally require the literal `datasource=` token, so an `ignore`
# comment is annotated enough to pass here while never matching a real
# customManager and never producing a Renovate PR.
#
# Pin findings (role defaults and group_vars): a `*_image:` needs an exact
# x.y.z tag and a sha256 digest; a `*_version:` must not be latest, release or
# stable. PIN_CHECK_MODE=warn (default) reports them as ::warning and exits 0;
# PIN_CHECK_MODE=enforce reports ::error and fails. A line opts out with
# `# pin-exempt: <reason>` on that same line.
#
# Exit codes:
#   0 — every pin in a covered path is annotated, and no pin finding fails
#       (warn mode reports pin findings and still exits 0)
#   1 — one or more unannotated pins found, or a pin finding in enforce mode
#       (see stderr for file:line)
#   2 — instrument error: zero files matched the covered path set. A repo
#       that opts into this check but has no covered files is misconfigured
#       (wrong ROOT, or none of roles/*/defaults|vars|tasks|templates,
#       inventory/, group_vars/, host_vars/, playbooks/, scripts/,
#       requirements*.yml exist here) — NOT evidence of a clean repo. A
#       "0 files, 0 unannotated" run must never look identical to "OK".
#       Also an unknown PIN_CHECK_MODE.
#
# Usage: [PIN_CHECK_MODE=warn|enforce] check-renovate-annotations.sh [ROOT]
#        (ROOT defaults to .; PIN_CHECK_MODE defaults to warn)

set -euo pipefail

ROOT="${1:-.}"

PIN_CHECK_MODE="${PIN_CHECK_MODE:-warn}"
if [[ "$PIN_CHECK_MODE" != warn && "$PIN_CHECK_MODE" != enforce ]]; then
  echo "Renovate annotation check ERROR: PIN_CHECK_MODE must be 'warn' or 'enforce', got '${PIN_CHECK_MODE}'." >&2
  exit 2
fi

# Paths mirror the customManagers' managerFilePatterns in renovate-presets.json.
PATH_ARGS=(
  -path '*/roles/*/defaults/main.yml' -o -path '*/roles/*/defaults/main.yaml'
  -o -path '*/roles/*/defaults/main/*.yml' -o -path '*/roles/*/defaults/main/*.yaml'
  -o -path '*/roles/*/vars/*.yml' -o -path '*/roles/*/vars/*.yaml'
  -o -path '*/roles/*/tasks/*.yml' -o -path '*/roles/*/tasks/*.yaml'
  -o -path '*/roles/*/templates/*'
  -o -path '*/inventory/*.yml' -o -path '*/inventory/*.yaml'
  -o -path '*/group_vars/*.yml' -o -path '*/group_vars/*.yaml'
  -o -path '*/host_vars/*.yml' -o -path '*/host_vars/*.yaml'
  -o -path '*/playbooks/*.yml' -o -path '*/playbooks/*.yaml'
  -o -path '*/scripts/*'
  -o -name 'requirements*.yml' -o -name 'requirements*.yaml'
)

# A pin line's shape — must match the scalar/list-item/git-SHA forms the
# annotated-pin customManagers extract. A generic `foo_image:` never matches
# `_version:`, so it needs no special-case exemption here.
version_re="^[[:space:]]*[A-Za-z0-9_]+_version:[[:space:]]*[\"']?[0-9vV]"
list_pin_re="^[[:space:]]*-[[:space:]]*[\"']?[^\"'[:space:]]+==[0-9]"
git_sha_re="^[[:space:]]*version:[[:space:]]*[\"']?[0-9a-fA-F]{40}"
# The FULL line shape, not just the `# renovate:` prefix — a typo
# (`datasorce=`) or a double space after the colon used to still satisfy a
# prefix-only check, passing this gate while matching no real
# renovate-presets.json matchString (those require the exact `datasource=`
# token), so the pin stayed silently untracked despite a "passing" CI run.
# bash's =~ uses POSIX ERE (no `(?:...)`), so groups here are plain `(...)`.
annotation_re="^[[:space:]]*# renovate: (datasource=[^[:space:]]+ depName=[^[:space:]]+( versioning=[^[:space:]]+)?( .*)?|ignore([[:space:]].*)?)\$"
comment_re="^[[:space:]]*#"

files_scanned=0
pins_seen=0
unannotated=0

while IFS= read -r -d '' f; do
  files_scanned=$((files_scanned + 1))

  # requirements.yml's git-refs customManager (renovate-presets.json) tolerates
  # ANY lines between the annotation and the `version:` SHA (`(?:[^\n]*\n)*?`)
  # — not just comment lines — because a real git-type collection entry always
  # carries a `- name: <url>` and `type: git` line in between. Every OTHER
  # annotation manager (role defaults/vars/tasks/...) only tolerates comment
  # lines in that gap. Scoping the wider tolerance to requirements*.yml keeps
  # this checker a faithful mirror of each manager's actual regex instead of
  # picking one gap width for every file class.
  case "$(basename "$f")" in
    requirements*.yml | requirements*.yaml) req_file=1 ;;
    *) req_file=0 ;;
  esac

  # Tracks whether an annotation was seen above, surviving blank lines and
  # any number of plain comment lines in between (mirrors the customManager
  # regex's `(?:\s*#[^\n]*\n)*` gap) — reset only by real content. In a
  # requirements.yml file, a real content line is reset only once it is
  # actually consumed as a matched pin, so the `- name:`/`type: git` carrier
  # lines of a git-type entry don't clear the state before `version:` is
  # reached.
  annotated=0
  lineno=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    lineno=$((lineno + 1))
    # CRLF files: strip the trailing \r `read -r` leaves in place, otherwise
    # the new `$`-anchored annotation_re never matches (the \r sits before
    # the anchor) and a stray \r leaks into the ::error text below.
    line=${line%$'\r'}

    # Blank line: annotation state carries through to the next line.
    [[ -z "${line//[[:space:]]/}" ]] && continue

    if [[ "$line" =~ $annotation_re ]]; then
      annotated=1
      continue
    fi

    # A plain (non-renovate) comment line: keep whatever state we had.
    if [[ "$line" =~ $comment_re ]]; then
      continue
    fi

    is_pin=0
    if [[ "$line" =~ $version_re || "$line" =~ $list_pin_re || "$line" =~ $git_sha_re ]]; then
      is_pin=1
    fi

    if [[ "$is_pin" -eq 1 ]]; then
      pins_seen=$((pins_seen + 1))
      if [[ "$annotated" -eq 0 ]]; then
        unannotated=$((unannotated + 1))
        echo "::error file=${f#./},line=${lineno}::unannotated version pin — add a '# renovate: datasource=... depName=...' comment on the line above (blank lines OK), or '# renovate: ignore — <reason>' if this is deliberately not a Renovate-trackable dependency: ${line}" >&2
      fi
      annotated=0
    elif [[ "$req_file" -eq 0 ]]; then
      annotated=0
    fi
  done <"$f"
done < <(find "$ROOT" -type f \( "${PATH_ARGS[@]}" \) -not -path '*/.git/*' -not -path '*/.worktrees/*' -print0)

echo "scanned ${files_scanned} files, ${pins_seen} pins, ${unannotated} unannotated" >&2

if [[ "$files_scanned" -eq 0 ]]; then
  echo "Renovate annotation check ERROR: zero files matched the covered path set under '${ROOT}'." >&2
  echo "Covered paths: roles/*/defaults|vars|tasks|templates, inventory/, group_vars/, host_vars/, playbooks/, scripts/, requirements*.yml." >&2
  echo "A repo that opts into this check but has none of those paths is misconfigured (wrong ROOT, or the toggle shouldn't be enabled here) — this is not evidence of a clean repo." >&2
  exit 2
fi

# Pin scan: container images and version pins in role defaults and group_vars.
PIN_PATH_ARGS=(
  -path '*/roles/*/defaults/*.yml' -o -path '*/roles/*/defaults/*.yaml'
  -o -path '*/group_vars/*.yml' -o -path '*/group_vars/*.yaml'
)
image_key_re="^[[:space:]]*([A-Za-z0-9_]*_image):[[:space:]]*(.*)\$"
version_key_re="^[[:space:]]*([A-Za-z0-9_]*_version):[[:space:]]*[\"']?(latest|release|stable)[\"']?([[:space:]]|#|\$)"
block_scalar_re='^[>|][-+0-9]*([[:space:]]|$)'
exempt_re="#[[:space:]]*pin-exempt:[[:space:]]*[^[:space:]]"
tag_pinned_re='^v?[0-9]+\.[0-9]+\.[0-9]+([-+_.~].*)?$'
digest_re='^sha256:[0-9a-fA-F]{64}$'

pin_files=0
pin_findings=0

# Scalar of a `key: <rest>` value: quotes removed, or cut at the first space so
# a trailing comment is dropped.
scalar_of() {
  local rest=$1
  case "$rest" in
    \"*) rest=${rest#\"}; printf '%s' "${rest%%\"*}" ;;
    \'*) rest=${rest#\'}; printf '%s' "${rest%%\'*}" ;;
    *) printf '%s' "${rest%%[[:space:]]*}" ;;
  esac
}

# Why an image reference is unpinned, or nothing. A Jinja expression in the last
# path segment is resolved from its variable, so it is not judged.
image_problem() {
  local ref=$1 name=$1 last tag="" digest="" dyn=0
  [[ "$ref" == *"{{"* ]] && dyn=1
  if [[ "$ref" == *@* ]]; then name=${ref%%@*} digest=${ref#*@}; fi
  last=${name##*/}
  [[ "$last" == *"{{"* ]] && return 0
  [[ "$last" == *:* ]] && tag=${last##*:}
  if [[ -n "$tag" ]]; then
    [[ "$tag" =~ $tag_pinned_re ]] || { echo "floating tag '${tag}'"; return 0; }
  elif [[ -z "$digest" && "$dyn" -eq 0 ]]; then
    echo "no tag or digest (implicit latest)"
    return 0
  fi
  [[ "$dyn" -eq 1 || "$digest" =~ $digest_re ]] || echo "no sha256 digest"
  return 0
}

# report_pin LINE MESSAGE — a finding in current_file, ::warning or ::error if enforced.
report_pin() {
  local level=warning
  if [[ "$PIN_CHECK_MODE" == enforce ]]; then level=error; fi
  echo "::${level} file=${current_file#./},line=$1::$2" >&2
  pin_findings=$((pin_findings + 1))
}

# check_image LINE KEY REF EXEMPT
check_image() {
  local problem
  if [[ -z "$3" || "$3" == "~" || "$3" == null || "$4" -eq 1 ]]; then return 0; fi
  problem=$(image_problem "$3")
  [[ -z "$problem" ]] || report_pin "$1" "container image $2 '$3' is not pinned: ${problem}; pin it or add '# pin-exempt: <reason>'"
  return 0
}

while IFS= read -r -d '' f; do
  pin_files=$((pin_files + 1))
  current_file=$f
  lineno=0 block_line=0 block_key="" block_exempt=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    lineno=$((lineno + 1))
    line=${line%$'\r'}
    exempt=0
    if [[ "$line" =~ $exempt_re ]]; then exempt=1; fi
    trimmed=${line#"${line%%[![:space:]]*}"}
    if [[ "$block_line" -gt 0 ]]; then
      # A block scalar's value is the first non-blank line after its key.
      if [[ -n "$trimmed" ]]; then
        check_image "$block_line" "$block_key" "$(scalar_of "$trimmed")" "$block_exempt"
        block_line=0
      fi
    elif [[ "$line" =~ $image_key_re ]]; then
      key=${BASH_REMATCH[1]} rest=${BASH_REMATCH[2]}
      if [[ "$rest" =~ $block_scalar_re ]]; then
        block_line=$lineno block_key=$key block_exempt=$exempt
      else
        check_image "$lineno" "$key" "$(scalar_of "$rest")" "$exempt"
      fi
    elif [[ "$line" =~ $version_key_re && "$exempt" -eq 0 ]]; then
      report_pin "$lineno" "${BASH_REMATCH[1]} is '${BASH_REMATCH[2]}', a floating version; pin it or add '# pin-exempt: <reason>'"
    fi
  done <"$f"
done < <(find "$ROOT" -type f \( "${PIN_PATH_ARGS[@]}" \) -not -path '*/.git/*' -not -path '*/.worktrees/*' -print0)

echo "pin check (${PIN_CHECK_MODE}): scanned ${pin_files} files, ${pin_findings} pin finding(s)." >&2

if [[ "$unannotated" -ne 0 ]]; then
  echo "Renovate annotation check FAILED — see file:line entries above." >&2
  exit 1
fi

if [[ "$pin_findings" -ne 0 && "$PIN_CHECK_MODE" == enforce ]]; then
  echo "Renovate annotation check FAILED — pin findings, see file:line entries above." >&2
  exit 1
fi

if [[ "$pin_findings" -ne 0 ]]; then
  echo "Renovate annotation check OK — ${pin_findings} pin finding(s) reported, not failing (warn mode)."
else
  echo "Renovate annotation check OK."
fi
