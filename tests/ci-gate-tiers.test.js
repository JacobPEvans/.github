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
  const run = step.match(/\n        run: \|\n([\s\S]*)$/);
  assert.ok(run, 'tier step has an inline run script');
  return run[1]
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(10))
    .join('\n');
}

function tierOutputs({ event, base = '', head = '', productionBranch = 'main', defaultBranch = 'develop', nonDoc = 'false' }) {
  const directory = mkdtempSync(join(tmpdir(), 'ci-gate-tier-'));
  const output = join(directory, 'github-output');
  try {
    execFileSync('bash', ['-e', '-c', tierScript()], {
      env: {
        PATH: process.env.PATH,
        GITHUB_OUTPUT: output,
        EVENT_NAME: event,
        BASE_REF: base,
        HEAD_REF: head,
        PRODUCTION_BRANCH: productionBranch,
        DEFAULT_BRANCH: defaultBranch,
        NON_DOC: nonDoc,
      },
    });
    return readFileSync(output, 'utf8').trim().split('\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function chooseTier(args) {
  return tierOutputs(args).find((line) => line.startsWith('test_tier='));
}

test('event, base and head choose the CI tiers', () => {
  assert.equal(chooseTier({ event: 'push' }), 'test_tier=full');
  assert.equal(chooseTier({ event: 'schedule' }), 'test_tier=relevance');
  // Feature and develop PRs into develop run the relevance tier.
  assert.equal(chooseTier({ event: 'pull_request', base: 'develop', head: 'feature/x', nonDoc: 'true' }), 'test_tier=relevance');
  assert.equal(chooseTier({ event: 'pull_request', base: 'develop', head: 'develop', nonDoc: 'true' }), 'test_tier=relevance');
  // Promotion PRs from develop or hotfix/* into the production branch run the full tier.
  assert.equal(chooseTier({ event: 'pull_request', base: 'main', head: 'develop', nonDoc: 'true' }), 'test_tier=full');
  assert.equal(chooseTier({ event: 'pull_request', base: 'main', head: 'hotfix/fix-1', nonDoc: 'true' }), 'test_tier=full');
  assert.equal(chooseTier({ event: 'pull_request', base: 'main', head: 'develop', nonDoc: 'false' }), 'test_tier=lint-only');
  // A feature branch straight into the production branch does not get the full tier.
  assert.equal(chooseTier({ event: 'pull_request', base: 'main', head: 'feature/x', nonDoc: 'true' }), 'test_tier=relevance');
  // Trunk repositories name their own production branch.
  assert.equal(chooseTier({ event: 'pull_request', base: 'trunk', head: 'develop', productionBranch: 'trunk' }), 'test_tier=lint-only');
});

test('trunk repositories run the full tier on feature pull requests into the production branch', () => {
  const trunk = { event: 'pull_request', base: 'main', head: 'feature/x', productionBranch: 'main', defaultBranch: 'main' };
  assert.equal(chooseTier({ ...trunk, nonDoc: 'true' }), 'test_tier=full');
  assert.equal(chooseTier({ ...trunk, nonDoc: 'false' }), 'test_tier=lint-only');
  // Git-flow repositories keep feature pull requests into the production branch on relevance.
  assert.equal(chooseTier({ ...trunk, defaultBranch: 'develop', nonDoc: 'true' }), 'test_tier=relevance');
  // Trunk repositories still reject pull requests into other branches.
  assert.equal(chooseTier({ ...trunk, base: 'feature/y', nonDoc: 'true' }), 'test_tier=relevance');
});

test('the production_pr output marks only promotion pull requests, case-sensitively', () => {
  const promotion = (args) => tierOutputs(args).includes('production_pr=true');
  assert.equal(promotion({ event: 'pull_request', base: 'main', head: 'develop' }), true);
  assert.equal(promotion({ event: 'pull_request', base: 'main', head: 'hotfix/fix-1' }), true);
  assert.equal(promotion({ event: 'pull_request', base: 'main', head: 'feature/x' }), false);
  assert.equal(promotion({ event: 'pull_request', base: 'main', head: 'HOTFIX/fix-1' }), false);
  assert.equal(promotion({ event: 'pull_request', base: 'main', head: 'Develop' }), false);
  assert.equal(promotion({ event: 'pull_request', base: 'develop', head: 'develop' }), false);
  assert.equal(promotion({ event: 'pull_request', base: 'Main', head: 'develop' }), false);
  assert.equal(promotion({ event: 'push', base: '', head: 'develop' }), false);
});

test('default-branch docs-only detection excludes the requested documentation paths', () => {
  assert.match(workflow, /predicate-quantifier: some-with-excludes/);
  for (const pattern of ["'!**.md'", "'!docs/**'", "'!LICENSE'", "'!CHANGELOG.md'"]) {
    assert.ok(workflow.includes(pattern), `missing ${pattern}`);
  }
});
