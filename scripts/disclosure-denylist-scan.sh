#!/usr/bin/env bash
# Disclosure denylist scan — fails a PR if any line it adds, the PR title, or
# the PR body contains a fixed string from the org denylist
# (DISCLOSURE_DENYLIST, materialized to a file by the caller workflow).
#
# The denylist itself is sensitive (the terms it lists are exactly what must
# never appear publicly), so a hit is reported as `path:line` ONLY — never
# the matched term, never the line content. Printing either would re-leak
# the very thing the scan exists to catch.
#
# Usage: disclosure-denylist-scan.sh <denylist-file> <base-ref> [allowlist-file]
#   <denylist-file> — one fixed string per line (blank lines / #-comments skipped)
#                     a line starting with `cs:` is matched case-sensitively (prefix dropped)
#   <base-ref>      — git ref to diff against; only lines added since it are scanned
#   [allowlist-file] — optional; one exact public identifier per line (same comment
#                     rules). Each is removed, case-insensitively, from the added diff
#                     lines before the denylist is matched, but only where it stands
#                     alone as a whole token: a letter, digit or `_` touching it, or a
#                     `-` before it or followed by a letter or `_`, keeps it in place.
#                     A `-` followed by a digit (a version suffix) does not. Title and
#                     body are never allowlisted.
#
# Reads PR_TITLE / PR_BODY / PR_AUTHOR from the environment (may be unset outside
# a PR). For a Renovate PR (renovate[bot], or jacobpevans-release-please[bot] for
# the self-hosted run in renovate.yml), the body's `### Release Notes` section (up
# to `### Configuration`) is skipped: it is upstream changelog text copied verbatim.
#
# Vendored paths: a repository may commit `.disclosure-vendored` at its root, one
# directory prefix per line (same comment rules), naming trees copied verbatim from a
# third party. Added lines under a listed prefix are not scanned. The list is read from
# the BASE ref, so a change cannot exempt its own new paths, and the list file itself
# is always scanned. A root entry (`.`, `/`, empty after `./`), an absolute path or a
# `..` segment is an instrument error. Title and body are always scanned.
#
# Reviewed paths: a repository may commit `.disclosure-reviewed` at its root, one
# directory prefix per line (same comment and validation rules), naming first-party
# folders that hold prose (documentation, prompts, reports) on which fixed-string
# matching false-hits. Added lines under a listed prefix are not matched against the
# denylist; they are left to a separate review job. The list is read from the BASE
# ref, so a change cannot exempt its own new paths, and the list file itself is
# always scanned. A path under both lists is treated as vendored. Title and body
# are always scanned.
#
# Review output: when DISCLOSURE_REVIEW_OUT names a file, it is created and filled
# with every changed file path that had at least one added line skipped because of
# `.disclosure-reviewed`, one per line and sorted — paths only, never line content,
# never a denylist term; it stays empty when there are none. When
# DISCLOSURE_EXEMPTIONS_OUT also names a file and the diff adds, removes or changes
# `.disclosure-reviewed` or `.disclosure-vendored`, the single line
# `exemptions-changed` is written to it. Nothing is written when a variable is unset.
#
# Exit codes:
#   0 — no hits
#   1 — one or more hits (see stdout for path:line)
#   2 — instrument error (missing/empty denylist file, missing allowlist file, bad base ref,
#       invalid vendored or reviewed entry, unwritable review/exemptions output file)

set -euo pipefail

DENYLIST_FILE="${1:?usage: disclosure-denylist-scan.sh <denylist-file> <base-ref> [allowlist-file]}"
BASE_REF="${2:?usage: disclosure-denylist-scan.sh <denylist-file> <base-ref> [allowlist-file]}"
ALLOWLIST_FILE="${3:-}"

if [[ ! -s "$DENYLIST_FILE" ]]; then
  echo "::error::denylist file missing or empty: $DENYLIST_FILE" >&2
  exit 2
fi
if [[ -n "$ALLOWLIST_FILE" && ! -f "$ALLOWLIST_FILE" ]]; then
  echo "::error::allowlist file missing: $ALLOWLIST_FILE" >&2
  exit 2
fi

# Review output files. Each is created (truncated) up front when its variable is set,
# so even a run that exits early leaves a well-defined empty file behind; an
# unwritable path is an instrument error, never a silent skip. DISCLOSURE_EXEMPTIONS_OUT
# is only honored alongside DISCLOSURE_REVIEW_OUT.
REVIEW_OUT="${DISCLOSURE_REVIEW_OUT:-}"
EXEMPTIONS_OUT="${DISCLOSURE_EXEMPTIONS_OUT:-}"
if [[ -n "$REVIEW_OUT" ]]; then
  if ! : > "$REVIEW_OUT"; then
    echo "::error::review output file not writable: $REVIEW_OUT" >&2
    exit 2
  fi
  if [[ -n "$EXEMPTIONS_OUT" ]] && ! : > "$EXEMPTIONS_OUT"; then
    echo "::error::exemptions output file not writable: $EXEMPTIONS_OUT" >&2
    exit 2
  fi
fi

# Strip blank lines and #-comments so an operator can annotate the source list.
PATTERNS_FILE="$(mktemp)"
CI_PATTERNS="$(mktemp)"
CS_PATTERNS="$(mktemp)"
ALLOW_IDS="$(mktemp)"
trap 'rm -f "$PATTERNS_FILE" "$CI_PATTERNS" "$CS_PATTERNS" "$ALLOW_IDS"' EXIT
grep -vE '^[[:space:]]*(#|$)' "$DENYLIST_FILE" > "$PATTERNS_FILE"
if grep -qE '^cs:[[:space:]]*$' "$PATTERNS_FILE"; then
  echo "::error::denylist cs: line has no term" >&2
  exit 2
fi

# A `cs:` line is a case-sensitive term: its prefix is dropped and the term goes to
# CS_PATTERNS. Every other line goes to CI_PATTERNS and is matched case-insensitively.
# A repository naming itself discloses nothing (Renovate links its own job log in every
# PR body), so the scanned repository's own name and owner/name are dropped from the
# patterns: case-insensitively from CI_PATTERNS, exactly from CS_PATTERNS.
#
# Patterns are matched with `grep -w`, which bounds each one to a whole token so
# a denylisted identifier no longer fires inside an unrelated word. `grep -w`
# counts underscore as a word character, so underscores are normalized to spaces
# on BOTH sides — patterns here, haystack in hit_lines — making `_` bound an
# identifier like every other separator. This mirrors gh-guard's hits_denylist(),
# whose measured result on 102 real PR bodies was 0% false positives with full
# recall on every hard identifier leak in that corpus.
own_repo="${GITHUB_REPOSITORY:-}"
awk -v full="$own_repo" -v name="${own_repo#*/}" -v cs="$CS_PATTERNS" '
  function trim(s) { gsub(/^[[:space:]]+|[[:space:]]+$/, "", s); return s }
  function bound(s) { gsub(/_/, " ", s); return s }
  /^cs:/ {
    term = substr($0, 4)
    if (trim(term) != full && trim(term) != name) print bound(term) > cs
    next
  }
  tolower(trim($0)) != tolower(full) && tolower(trim($0)) != tolower(name) { print bound($0) }
' "$PATTERNS_FILE" > "$CI_PATTERNS"

if [[ ! -s "$CI_PATTERNS" && ! -s "$CS_PATTERNS" ]]; then
  echo "::error::denylist file has no active patterns after stripping comments/blanks" >&2
  exit 2
fi

# Allowlisted identifiers, stripped the same way. With no allowlist argument the
# list stays empty and nothing is removed.
if [[ -n "$ALLOWLIST_FILE" ]]; then
  grep -vE '^[[:space:]]*(#|$)' "$ALLOWLIST_FILE" > "$ALLOW_IDS" || true
fi

hits=0

# Prints the line number of each line of <file> that hits a term, once per line. A list
# is passed to grep only when non-empty: some grep builds match every line for an empty
# pattern file.
hit_lines() {
  local file="$1"
  {
    if [[ -s "$CI_PATTERNS" ]]; then tr '_' ' ' < "$file" | grep -niwFf "$CI_PATTERNS" || true; fi
    if [[ -s "$CS_PATTERNS" ]]; then tr '_' ' ' < "$file" | grep -nwFf "$CS_PATTERNS" || true; fi
  } | cut -d: -f1 | sort -un
}

scan_file() {
  local label="$1" path="$2"
  [[ -f "$path" ]] || return 0
  # hit_lines keeps only line numbers, so no matched term or line content ever
  # reaches stdout.
  while read -r lineno; do
    [[ -n "$lineno" ]] || continue
    echo "${label}:${lineno}"
    hits=$((hits + 1))
  done < <(hit_lines "$path")
}

# Reads one prefix list from the BASE ref (never from HEAD, so a change cannot
# exempt its own new paths) and fills the global PREFIXES array with one
# normalized prefix per entry. Comments and blank lines are skipped, a `./`
# prefix and a missing trailing slash are normalized away, and a root entry, an
# absolute path or a `..` segment is an instrument error.
load_prefixes() {
  local list_name="$1" entry
  PREFIXES=()
  while IFS= read -r entry; do
    entry="${entry#"${entry%%[![:space:]]*}"}"; entry="${entry%"${entry##*[![:space:]]}"}"
    while [[ "$entry" == ./* ]]; do entry="${entry#./}"; done
    if [[ -z "$entry" || "$entry" == "." || "$entry" == /* || "/$entry/" == */../* ]]; then
      echo "::error::${list_name}: root, absolute or '..' entry is not allowed" >&2
      exit 2
    fi
    [[ "$entry" == */ ]] || entry="${entry}/"
    PREFIXES+=("$entry")
  done < <(git show "$BASE_REF:${list_name}" 2>/dev/null | grep -vE '^[[:space:]]*(#|$)' || true)
}

# True when a path starts with one of the prefix arguments. The trailing slash
# makes a prefix match whole directory names only, so `vendor2/` never matches a
# `vendor/` entry.
under_prefix() {
  local path="$1" prefix
  shift
  for prefix in "$@"; do
    if [[ "$path" == "$prefix"* ]]; then return 0; fi
  done
  return 1
}

# Lines the PR adds (base ref...HEAD). Unchanged lines in a touched file were
# already scanned when they were added, so a regenerated file (CHANGELOG) does
# not re-flag its history. Each hit reports the line's number in the new file.
scan_added() {
  local f="$1" content numbers n
  content="$(mktemp)"; numbers="$(mktemp)"
  git diff -U0 --no-color --no-ext-diff "$BASE_REF"...HEAD -- "$f" | awk -v c="$content" -v l="$numbers" '
    /^@@/ { inhunk = 1; split($3, a, ","); line = substr(a[1], 2) + 0; next }
    !inhunk { next }
    /^\+/ { print substr($0, 2) > c; print line > l; line++ }
  '
  if [[ -s "$content" ]] && under_prefix "$f" "${reviewed[@]+"${reviewed[@]}"}"; then
    # First-party prose under `.disclosure-reviewed`: report the path for the
    # separate review job instead of matching it. Only the path is recorded —
    # never line content, never a denylist term.
    reviewed_paths+=("$f")
    rm -f "$content" "$numbers"
    return
  fi
  # Each whole-token occurrence of an allowlisted identifier becomes a space, so its
  # neighbours keep their token boundaries and no line is dropped: `numbers` stays
  # aligned with `content`. An occurrence that is not a whole token stays, so a term
  # joined to an identifier still hits. A `-` then a digit is a version suffix and does
  # not join the identifier to a word.
  while IFS= read -r id; do
    [[ -n "$id" ]] || continue
    ALLOW_ID="$id" perl -pi -e 's/(?<![A-Za-z0-9_-])\Q$ENV{ALLOW_ID}\E(?![A-Za-z0-9_]|-[A-Za-z_])/ /gi' "$content"
  done < "$ALLOW_IDS"
  while IFS=: read -r n _; do
    [[ -n "$n" ]] || continue
    echo "${f}:$(sed -n "${n}p" "$numbers")"
    hits=$((hits + 1))
  done < <(hit_lines "$content")
  rm -f "$content" "$numbers"
}

# The allowlist file is not scanned in the repository that owns it. Its entries are
# public identifiers, reviewed in the change that adds them, and a change to it could
# not pass the scan otherwise. The skip is keyed on that repository, so a file at the
# same path in any other repository is scanned like every other. Title and body are
# always scanned.
ALLOWLIST_HOME_REPO="JacobPEvans/.github"
ALLOWLIST_HOME_PATH="scripts/disclosure-denylist-allowlist.txt"

if git rev-parse -q --verify "$BASE_REF" >/dev/null; then
  vendored=()
  reviewed=()
  reviewed_paths=()
  load_prefixes ".disclosure-vendored"
  vendored=("${PREFIXES[@]}")
  load_prefixes ".disclosure-reviewed"
  reviewed=("${PREFIXES[@]}")
  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    if under_prefix "$f" "${vendored[@]+"${vendored[@]}"}"; then continue; fi
    if [[ "${GITHUB_REPOSITORY:-}" == "$ALLOWLIST_HOME_REPO" && "$f" == "$ALLOWLIST_HOME_PATH" ]]; then
      continue
    fi
    scan_added "$f"
  done < <(git diff --name-only --diff-filter=d "$BASE_REF"...HEAD -- . 2>/dev/null || true)
  if [[ -n "$REVIEW_OUT" ]]; then
    if [[ "${#reviewed_paths[@]}" -gt 0 ]]; then
      printf '%s\n' "${reviewed_paths[@]}" | LC_ALL=C sort > "$REVIEW_OUT"
    fi
    if [[ -n "$EXEMPTIONS_OUT" ]]; then
      changed_lists="$(git diff --name-only "$BASE_REF"...HEAD -- .disclosure-reviewed .disclosure-vendored)" || {
        echo "::error::could not diff the exemption lists" >&2
        exit 2
      }
      if [[ -n "$changed_lists" ]]; then
        printf 'exemptions-changed\n' > "$EXEMPTIONS_OUT"
      fi
    fi
  fi
else
  echo "::error::base ref not found: $BASE_REF" >&2
  exit 2
fi

# PR title / body, scanned the same way via pseudo-files so no title/body
# text is ever echoed back — only "PR title:1" / "PR body:<n>" on a hit.
if [[ -n "${PR_TITLE:-}" ]]; then
  title_file="$(mktemp)"
  printf '%s\n' "$PR_TITLE" > "$title_file"
  scan_file "PR title" "$title_file"
  rm -f "$title_file"
fi
if [[ -n "${PR_BODY:-}" ]]; then
  body_file="$(mktemp)"
  if [[ "${PR_AUTHOR:-}" == "renovate[bot]" || "${PR_AUTHOR:-}" == "jacobpevans-release-please[bot]" ]]; then
    # Blank the skipped lines rather than drop them, so hits keep their body line numbers.
    printf '%s\n' "$PR_BODY" \
      | awk '/^### Release Notes/ { skip = 1 } /^### Configuration/ { skip = 0 } { print (skip ? "" : $0) }' \
      > "$body_file"
  else
    printf '%s\n' "$PR_BODY" > "$body_file"
  fi
  scan_file "PR body" "$body_file"
  rm -f "$body_file"
fi

if [[ "$hits" -gt 0 ]]; then
  echo "::error::disclosure denylist: ${hits} hit(s) — see path:line above" >&2
  exit 1
fi

echo "Disclosure denylist: 0 hits."
exit 0
