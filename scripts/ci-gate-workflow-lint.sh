#!/usr/bin/env bash
# Lints the working directory's .github/workflows with a pinned actionlint.
#
# Installs actionlint ACTIONLINT_VERSION from its GitHub release, verifies the
# archive against ACTIONLINT_SHA256, then runs it. The one filtered message is a
# known false positive: actionlint 1.7.12 does not define job.workflow_sha, which
# the reusable workflows use for their sparse checkouts (upstream
# rhysd/actionlint#707). Every other finding fails the job.
#
# Environment:
#   ACTIONLINT_BIN  use this binary instead of installing the pinned release
#   RUNNER_TEMP     scratch directory for the download (default: a mktemp dir)
set -euo pipefail

ACTIONLINT_VERSION=1.7.12
ACTIONLINT_SHA256=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8
IGNORE='property "workflow_sha" is not defined'

# Fails on a uses: ref that looks like a commit SHA (39+ hex characters) but is not exactly 40.
if grep -rnE 'uses:[[:space:]]*[^[:space:]]+/[^[:space:]@]+@([0-9a-fA-F]{39}|[0-9a-fA-F]{41,})([^0-9a-fA-F]|$)' .github/workflows; then
  echo "::error::uses: ref looks like a commit SHA but is not 40 hex characters (matches above)" >&2
  exit 1
fi

if [[ -z "${ACTIONLINT_BIN:-}" ]]; then
  scratch="${RUNNER_TEMP:-$(mktemp -d)}"
  archive="${scratch}/actionlint.tar.gz"
  curl -fsSL -o "$archive" \
    "https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/actionlint_${ACTIONLINT_VERSION}_linux_amd64.tar.gz"
  echo "${ACTIONLINT_SHA256}  ${archive}" | sha256sum --check --strict
  tar -xzf "$archive" -C "$scratch" actionlint
  ACTIONLINT_BIN="${scratch}/actionlint"
fi

"$ACTIONLINT_BIN" -config-file .gh-shared/.github/actionlint.yaml -ignore "$IGNORE"
