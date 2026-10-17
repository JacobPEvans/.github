#!/usr/bin/env bash
# Org file-size gate — loads configs/file-size-defaults.yml and merges optional
# per-repo .file-size.yml overrides (extended, exempt, scan only).
#
# Environment:
#   FILE_SIZE_DEFAULTS_CONFIG — path to org defaults YAML (required)
#
# Exit codes:
#   0 — all files within limits
#   1 — one or more files exceed their tier limit

set -euo pipefail

if [[ -z "${FILE_SIZE_DEFAULTS_CONFIG:-}" ]]; then
  echo "::error::FILE_SIZE_DEFAULTS_CONFIG is not set" >&2
  exit 1
fi
if [[ ! -f "$FILE_SIZE_DEFAULTS_CONFIG" ]]; then
  echo "::error::FILE_SIZE_DEFAULTS_CONFIG not found: $FILE_SIZE_DEFAULTS_CONFIG" >&2
  exit 1
fi

yq_list() {
  yq "$1" "$2" | tr -d '"' | tr '\n' ' '
}

WARN=$(yq '.defaults.warn // 6144' "$FILE_SIZE_DEFAULTS_CONFIG")
ERR=$(yq '.defaults.error // 12288' "$FILE_SIZE_DEFAULTS_CONFIG")
EXT_LIMIT=0
DEFAULT_SCAN=$(yq_list '.scan // [] | .[]' "$FILE_SIZE_DEFAULTS_CONFIG")
EXTENDED=" "
EXEMPT=" $(yq_list '.exempt // [] | .[]' "$FILE_SIZE_DEFAULTS_CONFIG") "

if [[ -f ".file-size.yml" ]]; then
  if yq -e '.defaults' .file-size.yml >/dev/null 2>&1; then
    echo "::warning file=.file-size.yml::.file-size.yml must not override org defaults (remove the defaults: block; see configs/file-size-defaults.yml in JacobPEvans/.github)"
  fi

  EXT_LIMIT=$(yq '.extended.limit // 0' .file-size.yml)

  cfg_scan=$(yq_list '.scan // [] | .[]' .file-size.yml)
  [[ -n "$cfg_scan" ]] && DEFAULT_SCAN="$cfg_scan"

  cfg_ext=$(yq_list '.extended.files // [] | .[]' .file-size.yml)
  [[ -n "$cfg_ext" ]] && EXTENDED="$EXTENDED$cfg_ext "

  cfg_exempt=$(yq_list '.exempt // [] | .[]' .file-size.yml)
  [[ -n "$cfg_exempt" ]] && EXEMPT="$EXEMPT$cfg_exempt "
fi

# When a token gate is active (.token-limits.yaml present), Markdown docs are
# governed by _token-limits.yml. Drop .md from this byte gate's scan.
if [[ -f ".token-limits.yaml" ]]; then
  new_scan=""
  for ext in $DEFAULT_SCAN; do
    [[ "$ext" = ".md" ]] && continue
    new_scan="$new_scan $ext"
  done
  DEFAULT_SCAN="$new_scan"
fi

name_args=()
first=true
for ext in $DEFAULT_SCAN; do
  $first && first=false || name_args+=(-o)
  name_args+=(-name "*${ext}")
done

file_size_bytes() {
  local f=$1
  if stat -c%s "$f" >/dev/null 2>&1; then
    stat -c%s "$f"
  elif stat -f%z "$f" >/dev/null 2>&1; then
    stat -f%z "$f"
  else
    wc -c < "$f" | tr -d ' '
  fi
}

errors=0
warnings=0
while IFS= read -r -d '' f; do
  base="${f##*/}"
  base="${base%.*}"
  size=$(file_size_bytes "$f")

  if [[ "$EXEMPT" == *" $base "* ]]; then
    continue
  fi

  if [[ "$EXT_LIMIT" -gt 0 ]] && [[ "$EXTENDED" == *" $base "* ]]; then
    limit=$EXT_LIMIT
    warn_threshold=$limit
  else
    limit=$ERR
    warn_threshold=$WARN
  fi

  if [[ "$size" -gt "$limit" ]]; then
    echo "::error file=$f::$f is $((size / 1024))KB (exceeds $((limit / 1024))KB limit)"
    errors=$((errors + 1))
  elif [[ $((size * 100)) -ge $((limit * 90)) ]]; then
    # Band at 90% of the limit: a warning only, never a failure.
    echo "::warning::$f is ${size}/${limit} (90%+)"
    warnings=$((warnings + 1))
  elif [[ "$size" -gt "$warn_threshold" ]]; then
    echo "::warning file=$f::$f is $((size / 1024))KB (exceeds $((warn_threshold / 1024))KB recommended)"
    warnings=$((warnings + 1))
  fi
done < <(
  find . -type f \( "${name_args[@]}" \) \
    -not -path "./.git/*" \
    -not -path "./.worktrees/*" \
    -not -path "./node_modules/*" \
    -not -path "./result/*" \
    -not -name "*.lock" \
    -not -name "package-lock.json" \
    -not -name "pnpm-lock.yaml" \
    -print0
)

echo "File size check: ${errors} error(s), ${warnings} warning(s)"
[[ "$errors" -gt 0 ]] && exit 1
exit 0
