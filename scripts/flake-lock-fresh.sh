#!/usr/bin/env bash
# Check the direct flake inputs owned by one of OWNERS.
#
# Usage: flake-lock-fresh.sh [--pr BASE_LOCK] [flake.lock]
#   default (freshness): fail when an owned input is not locked at its ref's commit.
#   --pr BASE_LOCK: compare against the base branch's lock, with no live lookup of
#                   refs. Fail when an owned input moved to a rev that does
#                   not descend from the base lock's rev. An input whose ref changed
#                   is a deliberate re-pin and is not compared (the ref change shows in
#                   flake.nix). A missing BASE_LOCK means the lock is new and only the
#                   pinned-rev rule applies.
# Env:   OWNERS                  space-separated input owners to check (case-insensitive);
#                                inputs from any other owner are ignored. Defaults to OWNED below.
#        GIT_TOKEN               optional token for private inputs
#        STALE_NAMES_FILE        optional; the stale input names are written there, one per line
#        FLAKE_REF_POLICY        fail (default) | warn; fail makes a dryvist input that names no
#                                floating major tag or exact release tag an error, warn reports
#                                it and keeps the branch check
#        FLAKE_LOCK_REMOTE_BASE  optional; URL prefix that <owner>/<repo>.git is read from
#                                (default https://github.com)
# Only root inputs of type github are checked. The ref is original.ref, resolved as a
# tag first and as a branch second; an input naming none resolves the repository's HEAD.
# An owned input pinned to a revision (original.rev) fails: ours always track a ref.
# A dryvist input must name a floating major tag (vN). Its locked rev is fresh when it is
# the tag's commit or one of that commit's ancestors, so the tag may move forward.
set -euo pipefail

base=
if [ "${1:-}" = --pr ]; then base=${2:?--pr needs a base lock path}; shift 2; fi
lock=${1:-flake.lock}
[ -f "$lock" ] || { echo "no $lock, nothing to check"; exit 0; }
# The one list of owners whose flake inputs are ours. JacobPEvans redirects to dryvist.
OWNED="dryvist JacobPEvans JacobPEvans-personal"
OWNERS=${OWNERS:-$OWNED}
remote_base=${FLAKE_LOCK_REMOTE_BASE:-https://github.com}
[ -n "${STALE_NAMES_FILE:-}" ] && : >"$STALE_NAMES_FILE"
max_age_days=${MAX_AGE_DAYS:-0}
if ! [[ $max_age_days =~ ^[0-9]+$ ]]; then
  echo "::error::MAX_AGE_DAYS must be a non-negative integer"
  exit 2
fi

git_remote() {
  local url=$1
  shift
  if [ -n "${GIT_TOKEN:-}" ] && [[ $url == https://github.com/* ]]; then
    GH_TOKEN=$GIT_TOKEN git -c credential.helper= -c 'credential.helper=!gh auth git-credential' "$@"
  else
    git "$@"
  fi
}

# remote_head <url> <ref>: the commit <ref> names on the remote. ls-remote lists an annotated
# tag's own object under <ref> and its commit under <ref>^{}; the peeled line wins.
remote_head() {
  git_remote "$1" ls-remote "$1" "$2" "$2^{}" | awk -v w="$2" '$2 == (w "^{}") { p = $1 } $2 == w { t = $1 } END { print (p ? p : t) }'
}

# reachable <url> <tag> <rev>: succeeds when <rev> is the tag's commit or one of its ancestors.
# The tag's history is fetched without blobs into a scratch repository.
reachable() {
  local tmp status=1
  tmp=$(mktemp -d)
  if git init -q --bare "$tmp" &&
    git_remote "$1" -C "$tmp" fetch -q --no-tags --filter=blob:none "$1" "+refs/tags/$2:refs/tags/$2" &&
    git -C "$tmp" merge-base --is-ancestor "$3" "refs/tags/$2" 2>/dev/null; then
    status=0
  fi
  rm -rf "$tmp"
  return "$status"
}

github_compare() {
  local url=$1
  if [ -n "${GIT_TOKEN:-}" ]; then
    curl -fsSL -H @<(printf 'Authorization: Bearer %s\n' "$GIT_TOKEN") "$url"
  else
    curl -fsSL "$url"
  fi
}

# name <TAB> owner/repo <TAB> ref (PINNED when pinned to a rev, HEAD when none) <TAB> locked rev
# (no field is ever empty)
inputs=$(jq -r --arg owners "$OWNERS" '
  ($owners | ascii_downcase | split(" ") | map(select(. != ""))) as $ours
  | . as $l | $l.nodes[$l.root].inputs // {} | to_entries[]
  | .key as $name | ($l.nodes[.value | if type == "string" then . else last end]) as $n
  | select($n.original.type? == "github" and (($n.original.owner | ascii_downcase) as $o | $ours | index($o)))
  | [$name, "\($n.original.owner)/\($n.original.repo)",
     (if $n.original.rev then "PINNED" elif $n.original.ref then $n.original.ref else "HEAD" end),
     $n.locked.rev] | @tsv' "$lock")

stale=0
while IFS=$'\t' read -r name repo ref rev; do
  [ -n "$name" ] || continue
  if [ "$ref" = PINNED ]; then
    echo "::error::owned input $name ($repo) is pinned to a rev; track a ref instead"
    stale=1
    continue
  fi
  owner=$(printf '%s' "${repo%%/*}" | tr '[:upper:]' '[:lower:]')
  if [ "$owner" = dryvist ] && ! [[ $ref =~ ^v[0-9]+(\.[0-9]+\.[0-9]+)?$ ]]; then
    case $ref in HEAD) named="no ref" ;; *) named="ref $ref" ;; esac
    if [ "${FLAKE_REF_POLICY:-fail}" = fail ]; then
      echo "::error::dryvist input $name ($repo) names $named; name a floating major tag (vN) or an exact release tag instead"
      stale=1
      continue
    fi
    echo "::warning::dryvist input $name ($repo) names $named; name a floating major tag (vN) or an exact release tag instead"
  fi
  if [ -n "$base" ]; then
    old=$([ ! -f "$base" ] || jq -r --arg n "$name" '. as $l | ($l.nodes[$l.root].inputs // {})[$n] // empty
      | $l.nodes[if type == "string" then . else last end].locked.rev // empty' "$base")
    if [ -z "$old" ] || [ "$old" = "$rev" ]; then
      echo "$name: unchanged from base"
      continue
    fi
    oldref=$(jq -r --arg n "$name" '. as $l | ($l.nodes[$l.root].inputs // {})[$n] // empty
      | $l.nodes[if type == "string" then . else last end].original
      | if .rev then "PINNED" elif .ref then .ref else "HEAD" end' "$base")
    if [ "$oldref" != "$ref" ]; then
      echo "$name: ref changed from $oldref to $ref; the new rev is not compared with the base rev"
      continue
    fi
    # status is "ahead" when the new rev descends from the base rev.
    status=$(github_compare "https://api.github.com/repos/$repo/compare/$old...$rev" | jq -r .status) || status=unknown
    if [ "$status" = ahead ]; then
      echo "$name: $old -> $rev moves forward"
    else
      echo "::error::$name ($repo) moves from $old to $rev, which does not descend from it ($status)"
      stale=1
    fi
    continue
  fi
  if [ "$max_age_days" -gt 0 ]; then
    echo "$name: age check enabled; checked with root inputs below"
    continue
  fi
  url="$remote_base/$repo.git"
  if [ "$ref" = HEAD ]; then
    head=$(remote_head "$url" HEAD)
  else
    head=$(remote_head "$url" "refs/tags/$ref")
    [ -n "$head" ] || head=$(remote_head "$url" "refs/heads/$ref")
  fi
  if [ -z "$head" ]; then
    echo "::error::$name: cannot resolve $ref of $repo"
    stale=1
  elif [ "$head" = "$rev" ]; then
    echo "$name: at head $head"
  elif [[ $ref =~ ^v[0-9]+$ ]]; then
    if reachable "$url" "$ref" "$rev"; then
      echo "$name: $rev is in the history of $ref ($head)"
    else
      echo "::error::$name ($repo $ref) locked at $rev, which is not in the history of $ref at $head. Run: nix flake update $name"
      [ -n "${STALE_NAMES_FILE:-}" ] && echo "$name" >>"$STALE_NAMES_FILE"
      stale=1
    fi
  else
    echo "::error::$name ($repo $ref) locked at $rev, branch head is $head. Run: nix flake update $name"
    [ -n "${STALE_NAMES_FILE:-}" ] && echo "$name" >>"$STALE_NAMES_FILE"
    stale=1
  fi
done <<<"$inputs"

if [ "$max_age_days" -gt 0 ]; then
  now=$(date -u +%s)
  cutoff=$((now - max_age_days * 86400))
  age_inputs=$(jq -r '
    . as $l | ($l.nodes[$l.root].inputs // {}) | to_entries[]
    | .key as $name
    | ($l.nodes[.value | if type == "string" then . else last end]) as $n
    | select($n.locked.type? == "github")
    | [$name,
       "\($n.locked.owner // $n.original.owner // "")/\($n.locked.repo // $n.original.repo // "")",
       ($n.original.ref // $n.locked.ref // "HEAD"),
       ($n.locked.lastModified // ""),
       ($n.locked.rev // "")]
    | @tsv' "$lock")

  while IFS=$'\t' read -r name repo ref last_modified rev; do
    [ -n "$name" ] || continue
    if ! [[ $last_modified =~ ^[0-9]+$ ]] || [ -z "$rev" ] || [[ $repo != */* ]]; then
      echo "::error::$name: cannot age-check its locked GitHub revision"
      stale=1
      continue
    fi
    if [ "$last_modified" -ge "$cutoff" ]; then
      echo "$name: locked revision is within $max_age_days days"
      continue
    fi

    url="$remote_base/$repo.git"
    if [ "$ref" = HEAD ]; then
      head=$(remote_head "$url" HEAD)
    else
      head=$(remote_head "$url" "refs/tags/$ref")
      [ -n "$head" ] || head=$(remote_head "$url" "refs/heads/$ref")
    fi
    if [ -z "$head" ]; then
      echo "::error::$name: cannot resolve $ref of $repo"
      stale=1
      continue
    fi
    if [ "$head" = "$rev" ]; then
      echo "$name: no newer commits on $ref"
      continue
    fi

    comparison=$(github_compare "https://api.github.com/repos/$repo/compare/$rev...$head") || comparison=
    if [ -z "$comparison" ]; then
      echo "::error::$name: cannot compare $rev with upstream $head"
      stale=1
      continue
    fi
    compare_status=$(jq -r '.status // "unknown"' <<<"$comparison")
    ahead_by=$(jq -r '.ahead_by // 0' <<<"$comparison")
    if [[ $compare_status == ahead || $compare_status == diverged ]] && [ "$ahead_by" -gt 0 ]; then
      age_days=$(((now - last_modified) / 86400))
      echo "::error::$name ($repo $ref) is $age_days days old with $ahead_by newer upstream commit(s); run: nix flake update $name"
      [ -n "${STALE_NAMES_FILE:-}" ] && printf '%s\n' "$name" >>"$STALE_NAMES_FILE"
      stale=1
    else
      echo "$name: no newer commits on $ref (compare status: $compare_status)"
    fi
  done <<<"$age_inputs"
fi
exit "$stale"
