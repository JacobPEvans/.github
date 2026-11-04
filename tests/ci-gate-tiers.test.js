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

function tierOutputs({ event, base = '', head = '', productionBranch = 'main', defaultBranch = 'develop', headRepo = 'owner/repo', baseRepo = 'owner/repo', nonDoc = 'false' }) {
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
        HEAD_REPO: headRepo,
        BASE_REPO: baseRepo,
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
  // A trunk repository (default branch trunk) gives its promotion-style pull requests the same tier.
  assert.equal(chooseTier({ event: 'pull_request', base: 'trunk', head: 'develop', productionBranch: 'trunk', defaultBranch: 'trunk', nonDoc: 'false' }), 'test_tier=lint-only');
});

test('trunk repositories run the full tier on feature pull requests into the production branch', () => {
  const trunk = { event: 'pull_request', base: 'main', head: 'feature/x', productionBranch: 'main', defaultBranch: 'main' };
  assert.equal(chooseTier({ ...trunk, nonDoc: 'true' }), 'test_tier=full');
  assert.equal(chooseTier({ ...trunk, nonDoc: 'false' }), 'test_tier=lint-only');
  assert.equal(tierOutputs({ ...trunk, nonDoc: 'true' }).includes('production_pr=true'), true);
  // A trunk named something other than main gets the same rule.
  const named = { event: 'pull_request', base: 'trunk', head: 'feature/x', productionBranch: 'trunk', defaultBranch: 'trunk' };
  assert.equal(chooseTier({ ...named, nonDoc: 'true' }), 'test_tier=full');
  assert.equal(tierOutputs({ ...named, nonDoc: 'true' }).includes('production_pr=true'), true);
  // Git-flow repositories keep feature pull requests into the production branch on relevance.
  assert.equal(chooseTier({ ...trunk, defaultBranch: 'develop', nonDoc: 'true' }), 'test_tier=relevance');
  assert.equal(tierOutputs({ ...trunk, defaultBranch: 'develop', nonDoc: 'true' }).includes('production_pr=true'), false);
  // Trunk repositories still reject pull requests into other branches.
  assert.equal(chooseTier({ ...trunk, base: 'feature/y', nonDoc: 'true' }), 'test_tier=relevance');
});

test('fork pull requests never get the promotion tier, even with a develop or hotfix head name', () => {
  const fork = { event: 'pull_request', base: 'main', productionBranch: 'main', defaultBranch: 'develop', headRepo: 'someone/fork', baseRepo: 'owner/repo', nonDoc: 'true' };
  assert.equal(chooseTier({ ...fork, head: 'develop' }), 'test_tier=relevance');
  assert.equal(chooseTier({ ...fork, head: 'hotfix/fix-1' }), 'test_tier=relevance');
  assert.equal(tierOutputs({ ...fork, head: 'develop' }).includes('production_pr=true'), false);
  // The same head name from the base repository keeps the promotion tier.
  assert.equal(chooseTier({ ...fork, head: 'develop', headRepo: 'owner/repo' }), 'test_tier=full');
  // A trunk repository's fork pull request into the trunk does not get the full tier either.
  const trunkFork = { ...fork, head: 'feature/x', defaultBranch: 'main', productionBranch: 'main' };
  assert.equal(chooseTier(trunkFork), 'test_tier=relevance');
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
