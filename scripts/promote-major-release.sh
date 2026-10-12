#!/usr/bin/env bash
# promote-major-release.sh <tag> [--no-canary]
#
# Moves the floating major tag for a published release tag. <tag> must be a
# stable vMAJOR.MINOR.PATCH tag, optionally followed by SemVer build metadata
# (+rev.1), already present in the current checkout; the commit it points at
# is handed to promote-major-tag.sh.
#
# A tag that is not vMAJOR.MINOR.PATCH[+metadata] is an error, except with --no-canary
# (a calling repo): that repo may publish component-prefixed tags, which have no
# floating major tag, so the script prints a notice and exits 0.
set -euo pipefail

tag="${1:-}"
mode="${2:-}"
tag_re='^v[0-9]+\.[0-9]+\.[0-9]+(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'

if [[ ! "$tag" =~ $tag_re ]]; then
  if [[ "$mode" == "--no-canary" ]]; then
    echo "::notice::'$tag' is not a vMAJOR.MINOR.PATCH release tag; no floating major tag to move."
    exit 0
  fi
  echo "::error::'$tag' is not a release tag (vMAJOR.MINOR.PATCH)"
  exit 1
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$here/promote-major-tag.sh" "$(git rev-parse "refs/tags/$tag^{commit}")" "$mode"
