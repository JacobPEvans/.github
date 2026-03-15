#!/usr/bin/env bash
# =============================================================================
# File Size Checker
# =============================================================================
# Checks file sizes against YAML config (.file-size.yml).
# Requires yq (Go mikefarah/yq or Python kislyuk/yq).
# Outputs GitHub Actions annotations in CI, plain text otherwise.
# Exit code = number of error-level violations (capped at 125).
# =============================================================================
set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults (used when no config file is present)
# ---------------------------------------------------------------------------
DEFAULT_WARN=5120
DEFAULT_ERROR=10240
DEFAULT_SCAN=(.nix .md .sh .yml .yaml .tf .py .j2)
EXTENDED_WARN=""
EXTENDED_ERROR=""
declare -a EXTENDED_FILES=()
declare -a EXEMPT_PATTERNS=()
declare -a SCAN_EXTENSIONS=()

# Resolve CI mode once at startup
CI_MODE=false
[[ -n "${GITHUB_ACTIONS:-}" ]] && CI_MODE=true

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
emit() {
  local level="$1" file="$2" msg="$3"
  if $CI_MODE; then
    echo "::${level} file=${file}::${msg}"
  else
    echo "${level^^}: ${file}: ${msg}"
  fi
}

# Populate a global array from a command's line-by-line output
# Usage: read_into ARRAY_NAME command args...
read_into() {
  local -n _arr=$1; shift
  while IFS= read -r line; do
    [[ -n "$line" ]] && _arr+=("$line")
  done < <("$@")
}

# Check if a basename matches any entry in a named array (glob matching)
# Usage: matches_list ARRAY_NAME "$file"
matches_list() {
  local -n _list=$1
  local bn
  bn=$(basename "$2")
  for pattern in "${_list[@]}"; do
    # shellcheck disable=SC2254
    case "$bn" in $pattern) return 0 ;; esac
  done
  return 1
}

# ---------------------------------------------------------------------------
# Parse config (requires yq)
# ---------------------------------------------------------------------------
parse_config() {
  local config="$1"

  if ! command -v yq &>/dev/null; then
    echo "ERROR: yq is required to parse ${config}" >&2
    return 1
  fi

  if ! yq '.' "$config" &>/dev/null; then
    echo "ERROR: yq failed to parse ${config}" >&2
    return 1
  fi

  DEFAULT_WARN=$(yq -r '.defaults.warn // empty' "$config")
  DEFAULT_ERROR=$(yq -r '.defaults.error // empty' "$config")
  EXTENDED_WARN=$(yq -r '.extended.warn // empty' "$config")
  EXTENDED_ERROR=$(yq -r '.extended.error // empty' "$config")

  read_into EXTENDED_FILES yq -r '.extended.files // [] | .[]' "$config"
  read_into EXEMPT_PATTERNS yq -r '.exempt // [] | .[]' "$config"
  read_into SCAN_EXTENSIONS yq -r '.scan // [] | .[]' "$config"

  : "${DEFAULT_WARN:=5120}"
  : "${DEFAULT_ERROR:=10240}"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  local config_file=".file-size.yml"

  if [[ -f "$config_file" ]]; then
    parse_config "$config_file" || exit 1
  fi

  if [[ ${#SCAN_EXTENSIONS[@]} -eq 0 ]]; then
    SCAN_EXTENSIONS=("${DEFAULT_SCAN[@]}")
  fi

  # Build find name predicates
  local name_args=() first=true
  for ext in "${SCAN_EXTENSIONS[@]}"; do
    $first && first=false || name_args+=(-o)
    name_args+=(-name "*${ext}")
  done

  local error_count=0 warning_count=0
  local size_bytes warn_limit error_limit size_kb limit_kb

  while IFS= read -r -d '' file; do
    if [[ ${#EXEMPT_PATTERNS[@]} -gt 0 ]] && matches_list EXEMPT_PATTERNS "$file"; then
      continue
    fi

    size_bytes=$(wc -c < "$file" | tr -d ' ')
    warn_limit="$DEFAULT_WARN"
    error_limit="$DEFAULT_ERROR"

    if [[ -n "${EXTENDED_WARN:-}" && -n "${EXTENDED_ERROR:-}" ]] \
       && [[ ${#EXTENDED_FILES[@]} -gt 0 ]] \
       && matches_list EXTENDED_FILES "$file"; then
      warn_limit="$EXTENDED_WARN"
      error_limit="$EXTENDED_ERROR"
    fi

    if [[ "$size_bytes" -ge "$error_limit" ]]; then
      size_kb=$(( size_bytes / 1024 )); limit_kb=$(( error_limit / 1024 ))
      emit error "$file" "${size_kb}KB exceeds ${limit_kb}KB error limit"
      error_count=$(( error_count + 1 ))
    elif [[ "$size_bytes" -ge "$warn_limit" ]]; then
      size_kb=$(( size_bytes / 1024 )); limit_kb=$(( warn_limit / 1024 ))
      emit warning "$file" "${size_kb}KB exceeds ${limit_kb}KB warning limit"
      warning_count=$(( warning_count + 1 ))
    fi
  done < <(find . -type f \( "${name_args[@]}" \) \
    -not -path "./.git/*" -not -path "./result/*" -not -path "./node_modules/*" \
    -print0 2>/dev/null | sort -z)

  if [[ $error_count -gt 0 || $warning_count -gt 0 ]]; then
    echo ""
    echo "File size check: ${error_count} error(s), ${warning_count} warning(s)"
  else
    echo "File size check: all files within limits"
  fi

  [[ $error_count -gt 125 ]] && exit 125
  exit "$error_count"
}

main "$@"
