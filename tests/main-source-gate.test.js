import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

function runGate(overrides = {}) {
  return spawnSync('bash', ['-c', gateScript], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      BASE_REF: 'main',
      BASE_REPOSITORY: 'JacobPEvans/.github',
      HEAD_REF: 'develop',
      HEAD_REPOSITORY: 'JacobPEvans/.github',
      ...overrides,
    },
  });
}

test('workflow is a standalone, least-permission pull request check', () => {
  assert.match(workflow, /^name: Main Source Gate$/m);
  assert.match(workflow, /^    types: \[opened, reopened, synchronize, edited\]$/m);
  assert.match(workflow, /^    branches: \[main\]$/m);
  assert.match(workflow, /^permissions: \{\}$/m);
  assert.match(workflow, /^    name: Main Source Gate$/m);
  assert.match(workflow, /^    timeout-minutes: 2$/m);
  assert.match(workflow, /^    permissions: \{\}$/m);
  assert.match(workflow, /^concurrency:\n  group: enterprise-main-source-gate-/m);
  assert.match(workflow, /^  cancel-in-progress: true$/m);
  assert.doesNotMatch(workflow, /pull_request_target|workflow_call|^\s+uses:/m);
  assert.doesNotMatch(gateScript, /\$\{\{/);
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
