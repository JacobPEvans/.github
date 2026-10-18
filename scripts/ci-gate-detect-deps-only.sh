#!/usr/bin/env bash
# ci-gate-detect-deps-only.sh — invoked by the `changes` job in _ci-gate.yml.
#
# Feeds the opt-in `nix_skip_deps_only` toggle: writes `is-deps-only=true` to
# $GITHUB_OUTPUT when the PR looks like a pure dependency bump, so callers can
# skip `nix-validate`/`nix-build` on it (still overridden by a flake.lock
# change — see `is-flake-lock-change` in the same job).
#
#   - Renovate: author + chore(deps) title (dual check since Renovate can also
#     open non-dependency PRs). The author is `renovate[bot]` for the hosted App
#     and `jacobpevans-release-please[bot]` for the self-hosted run (renovate.yml).
#   - Dependabot: author check alone (it exclusively opens dependency PRs).
#
# The Renovate author was `jacobpevans-github-actions*`, which no pull request
# has ever carried: every dependency PR in this org is opened by the Renovate
# GitHub App, whose `user.login` is `renovate[bot]`. So this always answered
# `false` and the toggle it feeds had never skipped anything. Verified against
# 21 `chore(deps` PRs across three repos — all `app/renovate`, none matching.
# A detector that cannot fire looks identical to one that decided not to.
#
# AUTHOR/COMMIT_MSG are empty on non-pull_request events, which safely
# evaluates to is-deps-only=false (never skip).
#
# Required env:
#   AUTHOR      — github.event.pull_request.user.login
#   COMMIT_MSG  — github.event.pull_request.title
#   GITHUB_OUTPUT — GitHub Actions output file (set by the runner)

set -euo pipefail

# --self-check: exercise both answers without a runner. Guards the author
# literals, which is the part that rotted — a wrong one still exits 0 and
# reports "not a dependency PR" forever.
if [[ ${1:-} == --self-check ]]; then
  fail=0
  for case in "renovate[bot]|chore(deps): bump x|true" \
              "renovate[bot]|feat: a real change|false" \
              "jacobpevans-release-please[bot]|chore(deps): bump x|true" \
              "jacobpevans-release-please[bot]|chore(main): release 1.2.3|false" \
              "dependabot[bot]|chore(deps): bump y|true" \
              "someone|chore(deps): bump z|false" \
              "||false"; do
    IFS='|' read -r a m want <<<"$case"
    out=$(mktemp)
    AUTHOR=$a COMMIT_MSG=$m GITHUB_OUTPUT=$out bash "$0"
    got=$(sed 's/^is-deps-only=//' "$out")
    rm -f "$out"
    [[ $got == "$want" ]] || { echo "FAIL: author='$a' title='$m' -> $got, want $want" >&2; fail=1; }
  done
  [[ $fail == 0 ]] && echo "self-check OK: 7 cases"
  exit $fail
fi

: "${GITHUB_OUTPUT:?required}"

if [[ (("${AUTHOR:-}" == "renovate[bot]" || "${AUTHOR:-}" == "jacobpevans-release-please[bot]") && "${COMMIT_MSG:-}" == chore\(deps\)*) || \
      "${AUTHOR:-}" == "dependabot[bot]" ]]; then
  echo "is-deps-only=true" >>"$GITHUB_OUTPUT"
else
  echo "is-deps-only=false" >>"$GITHUB_OUTPUT"
fi
