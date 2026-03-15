#!/usr/bin/env bash
# =============================================================================
# File Size Checker
# =============================================================================
# Checks file sizes against YAML config (.file-size.yml).
# Reads per-file, extended, and default tier limits.
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

# ---------------------------------------------------------------------------
# Detect CI environment
# ---------------------------------------------------------------------------
is_ci() { [[ -n "${GITHUB_ACTIONS:-}" ]]; }

# ---------------------------------------------------------------------------
# Annotation helpers
# ---------------------------------------------------------------------------
emit_warning() {
  local file="$1" msg="$2"
  if is_ci; then
    echo "::warning file=${file}::${msg}"
  else
    echo "WARNING: ${file}: ${msg}"
  fi
}

emit_error() {
  local file="$1" msg="$2"
  if is_ci; then
    echo "::error file=${file}::${msg}"
  else
    echo "ERROR: ${file}: ${msg}"
  fi
}

# ---------------------------------------------------------------------------
# YAML parsing helpers
# ---------------------------------------------------------------------------
# Detect any working yq (Go mikefarah/yq v4+, or Python kislyuk/yq).
has_yq() {
  command -v yq &>/dev/null
}

# Read a scalar value from YAML using yq (raw output to avoid quoted strings)
yq_scalar() {
  local file="$1" path="$2"
  yq -r "${path} // empty" "$file"
}

# Read a list from YAML using yq (one item per line, raw output)
yq_list() {
  local file="$1" path="$2"
  yq -r "${path} // [] | .[]" "$file"
}

# Fallback: parse nested scalar (e.g., defaults.warn) using awk
fallback_nested_scalar() {
  local file="$1" section="$2" key="$3"
  awk -v section="$section" -v key="$key" '
    $0 ~ "^" section ":" { s=1; next }
    s && /^[^ ]/ { exit }
    s && $0 ~ key ":" {
      sub(/.*:[ \t]*/, "")
      sub(/#.*/, "")
      gsub(/[ \t]/, "")
      print
      exit
    }
  ' "$file"
}

# Fallback: read a list from a YAML section using awk
fallback_list() {
  local file="$1" section="$2"
  awk -v section="$section" '
    BEGIN { in_section = 0; indent = -1 }
    {
      if ($0 ~ "^" section ":") {
        in_section = 1
        match($0, /^[[:space:]]*/); indent = RLENGTH
        next
      }
      if (in_section) {
        if (/^[[:space:]]*[^[:space:]#-]/) {
          match($0, /^[[:space:]]*/);
          if (RLENGTH <= indent) exit
        }
        if (/^[[:space:]]*- /) {
          val = $0
          sub(/^[[:space:]]*- ["'"'"']?/, "", val)
          sub(/["'"'"']?[[:space:]]*(#.*)?$/, "", val)
          if (val != "") print val
        }
      }
    }
  ' "$file"
}

# Fallback: read nested list (e.g., extended.files) using awk
fallback_nested_list() {
  local file="$1" section="$2" key="$3"
  awk -v section="$section" -v key="$key" '
    $0 ~ "^" section ":" { s=1; next }
    s && /^[^ ]/ { exit }
    s && $0 ~ key ":" { f=1; next }
    s && f && /^[[:space:]]*- / {
      val = $0
      sub(/^[[:space:]]*- ["'"'"']?/, "", val)
      sub(/["'"'"']?[[:space:]]*(#.*)?$/, "", val)
      print val
    }
    s && f && /^[[:space:]]*[^[:space:]#-]/ && !($0 ~ key ":") { exit }
  ' "$file"
}

# ---------------------------------------------------------------------------
# Parse config
# ---------------------------------------------------------------------------
parse_config() {
  local config="$1"

  if has_yq; then
    # Validate that yq can parse the config; fail fast on malformed YAML
    if ! yq '.' "$config" &>/dev/null; then
      echo "ERROR: yq failed to parse ${config}" >&2
      exit 1
    fi
    DEFAULT_WARN=$(yq_scalar "$config" ".defaults.warn")
    DEFAULT_ERROR=$(yq_scalar "$config" ".defaults.error")
    EXTENDED_WARN=$(yq_scalar "$config" ".extended.warn")
    EXTENDED_ERROR=$(yq_scalar "$config" ".extended.error")

    while IFS= read -r line; do
      [[ -n "$line" ]] && EXTENDED_FILES+=("$line")
    done < <(yq_list "$config" ".extended.files")

    while IFS= read -r line; do
      [[ -n "$line" ]] && EXEMPT_PATTERNS+=("$line")
    done < <(yq_list "$config" ".exempt")

    while IFS= read -r line; do
      [[ -n "$line" ]] && SCAN_EXTENSIONS+=("$line")
    done < <(yq_list "$config" ".scan")
  else
    DEFAULT_WARN=$(fallback_nested_scalar "$config" "defaults" "warn")
    DEFAULT_ERROR=$(fallback_nested_scalar "$config" "defaults" "error")
    EXTENDED_WARN=$(fallback_nested_scalar "$config" "extended" "warn")
    EXTENDED_ERROR=$(fallback_nested_scalar "$config" "extended" "error")

    while IFS= read -r line; do
      [[ -n "$line" ]] && EXTENDED_FILES+=("$line")
    done < <(fallback_nested_list "$config" "extended" "files")

    while IFS= read -r line; do
      [[ -n "$line" ]] && EXEMPT_PATTERNS+=("$line")
    done < <(fallback_list "$config" "exempt")

    while IFS= read -r line; do
      [[ -n "$line" ]] && SCAN_EXTENSIONS+=("$line")
    done < <(fallback_list "$config" "scan")
  fi

  # Apply defaults for empty values
  : "${DEFAULT_WARN:=5120}"
  : "${DEFAULT_ERROR:=10240}"

  if [[ ${#SCAN_EXTENSIONS[@]} -eq 0 ]]; then
    SCAN_EXTENSIONS=("${DEFAULT_SCAN[@]}")
  fi
}

# ---------------------------------------------------------------------------
# Check if a filename matches an exempt pattern
# ---------------------------------------------------------------------------
is_exempt() {
  local file="$1" basename
  basename=$(basename "$file")
  for pattern in "${EXEMPT_PATTERNS[@]}"; do
    # shellcheck disable=SC2254
    case "$basename" in
      $pattern) return 0 ;;
    esac
    if [[ "$file" == "$pattern" || "$file" == "./$pattern" ]]; then
      return 0
    fi
  done
  return 1
}

# ---------------------------------------------------------------------------
# Check if a filename is in the extended list
# ---------------------------------------------------------------------------
is_extended() {
  local file="$1" basename
  basename=$(basename "$file")
  for ext_file in "${EXTENDED_FILES[@]}"; do
    if [[ "$basename" == "$ext_file" ]]; then
      return 0
    fi
  done
  return 1
}

# ---------------------------------------------------------------------------
# Get file size in bytes (cross-platform)
# ---------------------------------------------------------------------------
file_size_bytes() {
  if stat --version &>/dev/null 2>&1; then
    stat -c%s "$1"
  else
    stat -f%z "$1"
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  local config_file=".file-size.yml"
  local error_count=0
  local warning_count=0

  if [[ -f "$config_file" ]]; then
    parse_config "$config_file"
  else
    SCAN_EXTENSIONS=("${DEFAULT_SCAN[@]}")
  fi

  # Build find name predicates
  local name_args=()
  local first=true
  for ext in "${SCAN_EXTENSIONS[@]}"; do
    if $first; then first=false; else name_args+=(-o); fi
    name_args+=(-name "*${ext}")
  done

  while IFS= read -r -d '' file; do
    if [[ ${#EXEMPT_PATTERNS[@]} -gt 0 ]] && is_exempt "$file"; then
      continue
    fi

    local size_bytes
    size_bytes=$(file_size_bytes "$file")

    local warn_limit="$DEFAULT_WARN"
    local error_limit="$DEFAULT_ERROR"

    if [[ -n "${EXTENDED_WARN:-}" && -n "${EXTENDED_ERROR:-}" ]] \
       && [[ ${#EXTENDED_FILES[@]} -gt 0 ]] \
       && is_extended "$file"; then
      warn_limit="$EXTENDED_WARN"
      error_limit="$EXTENDED_ERROR"
    fi

    if [[ "$size_bytes" -ge "$error_limit" ]]; then
      local size_kb=$(( size_bytes / 1024 ))
      local limit_kb=$(( error_limit / 1024 ))
      emit_error "$file" "${size_kb}KB exceeds ${limit_kb}KB error limit"
      error_count=$(( error_count + 1 ))
    elif [[ "$size_bytes" -ge "$warn_limit" ]]; then
      local size_kb=$(( size_bytes / 1024 ))
      local limit_kb=$(( warn_limit / 1024 ))
      emit_warning "$file" "${size_kb}KB exceeds ${limit_kb}KB warning limit"
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

  if [[ $error_count -gt 125 ]]; then exit 125; fi
  exit "$error_count"
}

main "$@"
