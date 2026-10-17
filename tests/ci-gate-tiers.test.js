import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const workflow = readFileSync(
  new URL('../.github/workflows/_ci-gate.yml', import.meta.url),
  'utf8',
);

function tierScript() {
  const start = workflow.indexOf('- name: Select test tier from the event and diff');
  const next = workflow.indexOf('\n      - name:', start + 1);
  const step = workflow.slice(start, next);
  const run = step.match(/\n        run: \|\n((?: {10}[^\n]*(?:\n|$))*)/);
  assert.ok(run, 'tier step has an inline run script');
  return run[1]
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(10))
    .join('\n');
}

function chooseTier({ event, base = '', defaultBranch = 'main', nonDoc = 'false' }) {
  const directory = mkdtempSync(join(tmpdir(), 'ci-gate-tier-'));
  const output = join(directory, 'github-output');
  try {
    execFileSync('bash', ['-e', '-c', tierScript()], {
      env: {
        PATH: process.env.PATH,
        GITHUB_OUTPUT: output,
        EVENT_NAME: event,
        BASE_REF: base,
        DEFAULT_BRANCH: defaultBranch,
        NON_DOC: nonDoc,
      },
    });
    return readFileSync(output, 'utf8').trim();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('event and default-branch diff choose the three CI tiers', () => {
  assert.equal(chooseTier({ event: 'push' }), 'test_tier=full');
  assert.equal(chooseTier({ event: 'pull_request', base: 'develop', nonDoc: 'true' }), 'test_tier=relevance');
  assert.equal(chooseTier({ event: 'pull_request', base: 'main', nonDoc: 'true' }), 'test_tier=full');
  assert.equal(chooseTier({ event: 'pull_request', base: 'trunk', defaultBranch: 'trunk' }), 'test_tier=lint-only');
  assert.equal(chooseTier({ event: 'schedule' }), 'test_tier=relevance');
});

test('default-branch docs-only detection excludes the requested documentation paths', () => {
  assert.match(workflow, /predicate-quantifier: some-with-excludes/);
  for (const pattern of ["'!**.md'", "'!docs/**'", "'!LICENSE'", "'!CHANGELOG.md'"]) {
    assert.ok(workflow.includes(pattern), `missing ${pattern}`);
  }
});
