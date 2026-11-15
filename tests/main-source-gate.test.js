import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const workflow = readFileSync(
  fileURLToPath(new URL('../.github/workflows/main-source-gate.yml', import.meta.url)),
  'utf8',
);

function extractRunBlock(text) {
  const marker = '        run: |\n';
  const start = text.indexOf(marker);
  assert.notEqual(start, -1, 'workflow has an inline shell decision');
  const body = text.slice(start + marker.length);
  const lines = [];
  for (const line of body.split('\n')) {
    if (line !== '' && !line.startsWith('          ')) break;
    lines.push(line === '' ? '' : line.slice(10));
  }
  return lines.join('\n');
}

const gateScript = extractRunBlock(workflow);

function runGate(overrides = {}, { compareStatus = 'behind', ghExitStatus = 0 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'main-source-gate-'));
  const ghStub = join(directory, 'gh');
  const ghLog = join(directory, 'gh.log');
  writeFileSync(
    ghStub,
    [
      '#!/usr/bin/env bash',
      'printf \'%s\\n\' "$*" >> "$GH_STUB_LOG"',
      `if [[ "$1" == api && "$2" == */compare/develop...* ]]; then`,
      `  if [[ ${ghExitStatus} -ne 0 ]]; then exit ${ghExitStatus}; fi`,
      `  printf '%s\\n' '${compareStatus}'`,
      '  exit 0',
      'fi',
      "printf 'unexpected gh invocation: %s\\n' \"$*\" >&2",
      'exit 99',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );

  try {
    return spawnSync('bash', ['-c', gateScript], {
      encoding: 'utf8',
      env: {
        PATH: `${directory}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        BASE_REF: 'main',
        BASE_REPOSITORY: 'JacobPEvans/.github',
        HEAD_REF: 'develop',
        HEAD_REPOSITORY: 'JacobPEvans/.github',
        HEAD_SHA: '0123456789abcdef0123456789abcdef01234567',
        GH_STUB_LOG: ghLog,
        ...overrides,
      },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('workflow is a standalone, least-permission pull request check', () => {
  assert.match(workflow, /^name: Main Source Gate$/m);
  assert.match(workflow, /^    types: \[opened, reopened, synchronize, edited\]$/m);
  assert.match(workflow, /^    branches: \[main\]$/m);
  assert.match(workflow, /^permissions: \{\}$/m);
  assert.match(workflow, /^    name: Main Source Gate$/m);
  assert.match(workflow, /^    timeout-minutes: 2$/m);
  assert.match(workflow, /^    permissions:\n      contents: read$/m);
  assert.match(workflow, /^concurrency:\n  group: enterprise-main-source-gate-/m);
  assert.match(workflow, /^  cancel-in-progress: false$/m);
  assert.match(workflow, /^  workflow_call:$/m);
  assert.doesNotMatch(workflow, /pull_request_target|^\s+uses:/m);
  assert.doesNotMatch(gateScript, /\$\{\{/);
});

test('organization .github repositories are skipped by the job-level guard', () => {
  assert.match(
    workflow,
    /^  main-source-gate:\n    name: Main Source Gate\n    # Organization \.github repositories are trunk and are not ruleset targets\.\n    if: github\.event\.repository\.name != '\.github'$/m,
  );
});

const decisions = [
  ['develop passes', {}, 0],
  ['hotfix/foo passes', { HEAD_REF: 'hotfix/foo' }, 0],
  ['empty hotfix name fails', { HEAD_REF: 'hotfix/' }, 1],
  ['nested hotfix path fails', { HEAD_REF: 'hotfix/a/b' }, 1],
  ['feature branch fails', { HEAD_REF: 'feature/x' }, 1],
  ['release-please branch fails', { HEAD_REF: 'release-please--branches--develop' }, 1],
  ['Renovate branch fails', { HEAD_REF: 'renovate/x' }, 1],
  ['fork head named develop fails', { HEAD_REPOSITORY: 'fork-owner/.github' }, 1],
  ['base other than main fails', { BASE_REF: 'develop' }, 1],
];

for (const [description, overrides, expectedStatus] of decisions) {
  test(description, () => {
    const result = runGate(overrides);
    assert.ifError(result.error);
    assert.equal(result.status, expectedStatus, result.stderr);
    if (expectedStatus === 0) {
      assert.match(result.stdout, /Main Source Gate passed/);
    } else {
      assert.match(result.stderr, /same repository and use exactly develop or hotfix/);
      assert.match(result.stderr, /Head ref:/);
    }
  });
}

const promoteDecisions = [
  ['promote/2026-11-15 with compare status behind passes', 'behind', 0],
  ['promote/2026-11-15 with compare status identical passes', 'identical', 0],
  ['promote/2026-11-15 with compare status ahead fails', 'ahead', 1],
  ['promote/2026-11-15 with compare status diverged fails', 'diverged', 1],
];

for (const [description, compareStatus, expectedStatus] of promoteDecisions) {
  test(description, () => {
    const result = runGate({ HEAD_REF: 'promote/2026-11-15' }, { compareStatus });
    assert.ifError(result.error);
    assert.equal(result.status, expectedStatus, result.stderr);
    if (expectedStatus === 0) {
      assert.match(result.stdout, /Main Source Gate passed/);
    } else {
      assert.match(result.stdout, /::error::/);
      assert.match(result.stdout, /contained in develop/);
      assert.match(result.stdout, new RegExp(`compare status: ${compareStatus}`));
    }
  });
}

test('promote/not-a-date fails', () => {
  const result = runGate({ HEAD_REF: 'promote/not-a-date' });
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /::error::/);
  assert.match(result.stdout, /promote\/YYYY-MM-DD/);
  assert.match(result.stdout, /Head ref: promote\/not-a-date/);
});

test('fork head named promote/2026-11-15 fails', () => {
  const result = runGate({
    HEAD_REF: 'promote/2026-11-15',
    HEAD_REPOSITORY: 'fork-owner/.github',
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /same repository and use exactly develop or hotfix/);
});

test('shell metacharacters in a branch ref are printed literally and never executed', () => {
  const directory = mkdtempSync(join(tmpdir(), 'main-source-gate-'));
  const marker = join(directory, 'executed');
  const headRef = 'feature/$(touch${IFS}${INJECTION_MARKER})';

  try {
    const result = runGate({ HEAD_REF: headRef, INJECTION_MARKER: marker });
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stderr.includes(`Head ref: ${headRef}`), result.stderr);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
