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
# Usage: disclosure-denylist-scan.sh <denylist-file> <base-ref>
#   <denylist-file> — one fixed string per line (blank lines / #-comments skipped)
#   <base-ref>      — git ref to diff against; only lines added since it are scanned
#
# Reads PR_TITLE / PR_BODY / PR_AUTHOR from the environment (may be unset outside
# a PR). For a renovate[bot] PR, the body's `### Release Notes` section (up to
# `### Configuration`) is skipped: it is upstream changelog text copied verbatim.
#
# Exit codes:
#   0 — no hits
#   1 — one or more hits (see stdout for path:line)
#   2 — instrument error (missing/empty denylist file, bad base ref)

set -euo pipefail

DENYLIST_FILE="${1:?usage: disclosure-denylist-scan.sh <denylist-file> <base-ref>}"
BASE_REF="${2:?usage: disclosure-denylist-scan.sh <denylist-file> <base-ref>}"

if [[ ! -s "$DENYLIST_FILE" ]]; then
  echo "::error::denylist file missing or empty: $DENYLIST_FILE" >&2
  exit 2
fi

# Strip blank lines and #-comments so an operator can annotate the source list.
PATTERNS_FILE="$(mktemp)"
trap 'rm -f "$PATTERNS_FILE"' EXIT
grep -vE '^[[:space:]]*(#|$)' "$DENYLIST_FILE" > "$PATTERNS_FILE"

# A repository naming itself discloses nothing (Renovate links its own job log
# in every PR body), so the scanned repository's own name and owner/name are
# dropped from the patterns.
if [[ -n "${GITHUB_REPOSITORY:-}" ]]; then
  own_patterns="$(mktemp)"
  awk -v full="$GITHUB_REPOSITORY" -v name="${GITHUB_REPOSITORY#*/}" '
    { t = $0; gsub(/^[[:space:]]+|[[:space:]]+$/, "", t) }
    tolower(t) != tolower(full) && tolower(t) != tolower(name)
  ' "$PATTERNS_FILE" > "$own_patterns"
  mv "$own_patterns" "$PATTERNS_FILE"
fi

if [[ ! -s "$PATTERNS_FILE" ]]; then
  echo "::error::denylist file has no active patterns after stripping comments/blanks" >&2
  exit 2
fi

# Patterns are matched with `grep -w`, which bounds each one to a whole token so
# a denylisted identifier no longer fires inside an unrelated word. `grep -w`
# counts underscore as a word character, so underscores are normalized to spaces
# on BOTH sides — patterns here, haystack at each call site — making `_` bound an
# identifier like every other separator. This mirrors gh-guard's hits_denylist(),
# whose measured result on 102 real PR bodies was 0% false positives with full
# recall on every hard identifier leak in that corpus.
BOUNDED_PATTERNS="$(mktemp)"
trap 'rm -f "$PATTERNS_FILE" "$BOUNDED_PATTERNS"' EXIT
tr '_' ' ' < "$PATTERNS_FILE" > "$BOUNDED_PATTERNS"

hits=0

scan_file() {
  local label="$1" path="$2"
  [[ -f "$path" ]] || return 0
  # -n gives "line:content"; cut keeps only the number, so no matched term or
  # line content ever reaches stdout. Underscores are normalized to spaces
  # first: grep -w treats `_` as a word character, so without this an
  # identifier glued to a word by `_` would escape the boundary.
  while read -r lineno; do
    [[ -n "$lineno" ]] || continue
    echo "${label}:${lineno}"
    hits=$((hits + 1))
  done < <(tr '_' ' ' < "$path" \
             | grep -niwFf "$BOUNDED_PATTERNS" \
             | cut -d: -f1 || true)
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
  while IFS=: read -r n _; do
    [[ -n "$n" ]] || continue
    echo "${f}:$(sed -n "${n}p" "$numbers")"
    hits=$((hits + 1))
  done < <(tr '_' ' ' < "$content" \
             | grep -niwFf "$BOUNDED_PATTERNS" \
             | cut -d: -f1 || true)
  rm -f "$content" "$numbers"
}

if git rev-parse -q --verify "$BASE_REF" >/dev/null; then
  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    scan_added "$f"
  done < <(git diff --name-only --diff-filter=d "$BASE_REF"...HEAD -- . 2>/dev/null || true)
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
  if [[ "${PR_AUTHOR:-}" == "renovate[bot]" ]]; then
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
