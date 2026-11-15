'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');

// The lane decision lives in ONE jq program that .github/workflows/_lane.yml
// reads at runtime, so these cases exercise the exact table the gate runs.
const laneJq = '.github/scripts/lane.jq';
const laneWorkflow = readFileSync('.github/workflows/_lane.yml', 'utf8');

const DEFAULT_LOGINS = {
  bot_logins: ['renovate[bot]', 'jacobpevans-release-please[bot]'],
  automation_logins: ['jacobpevans-claude[bot]'],
  sandbox_logins: ['jacobs-agent-smith[bot]'],
};

function decide(overrides = {}) {
  const input = {
    event_name: 'pull_request',
    repository: 'JacobPEvans/.github',
    author: 'a-contributor',
    head_ref: 'feature/x',
    head_repo: 'JacobPEvans/.github',
    labels: [],
    additions: 20,
    deletions: 10,
    changed_paths: ['src/app.py'],
    low_risk_paths: [],
    instruction_paths: [],
    guarded_paths: [],
    ...DEFAULT_LOGINS,
    ...overrides,
  };
  return JSON.parse(execFileSync('jq', ['-f', laneJq], {
    input: JSON.stringify(input),
    encoding: 'utf8',
  }));
}

function stepRunScript(stepName) {
  const start = laneWorkflow.indexOf(`- name: ${stepName}`);
  assert.notEqual(start, -1, `${stepName} step exists`);
  const run = laneWorkflow.slice(start).match(/\n        run: \|\n((?: {10}[^\n]*(?:\n|$))*)/);
  assert.ok(run, `${stepName} step has an inline run script`);
  return run[1]
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(10))
    .join('\n');
}

function runStep(stepName, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'lane-step-'));
  const output = join(directory, 'github-output');
  execFileSync('bash', ['-e', '-c', stepRunScript(stepName)], {
    env: {
      PATH: process.env.PATH,
      GITHUB_OUTPUT: output,
      ...overrides,
    },
  });
  return readFileSync(output, 'utf8').trim();
}

test('a guarded path wins over the land-first label', () => {
  const decision = decide({
    labels: ['land-first'],
    guarded_paths: ['.github/workflows/_ci-gate.yml'],
  });
  assert.equal(decision.lane, 'guarded');
  assert.equal(decision.heavy_jobs, 'true');
  assert.equal(decision.fast_path, 'false');
});

test('an instruction file of three lines is never tiny', () => {
  const decision = decide({
    additions: 3,
    deletions: 0,
    changed_paths: ['AGENTS.md'],
    low_risk_paths: ['AGENTS.md'],
    instruction_paths: ['AGENTS.md'],
  });
  assert.equal(decision.lane, 'normal');
  assert.equal(decision.tiny, 'false');
});

test('ten changed lines of docs is tiny', () => {
  const decision = decide({
    additions: 6,
    deletions: 4,
    changed_paths: ['docs/guide.md'],
    low_risk_paths: ['docs/guide.md'],
  });
  assert.equal(decision.lane, 'tiny');
  assert.equal(decision.tiny, 'true');
  assert.equal(decision.fast_path, 'true');
  assert.equal(decision.heavy_jobs, 'false');
});

test('eleven changed lines is normal', () => {
  const decision = decide({
    additions: 11,
    deletions: 0,
    changed_paths: ['docs/guide.md'],
    low_risk_paths: ['docs/guide.md'],
  });
  assert.equal(decision.lane, 'normal');
  assert.equal(decision.heavy_jobs, 'true');
});

test('the land-first label takes the land-first lane on a normal path', () => {
  const decision = decide({
    labels: ['land-first'],
    additions: 40,
    deletions: 20,
    changed_paths: ['src/app.py'],
  });
  assert.equal(decision.lane, 'land-first');
  assert.equal(decision.tiny, 'false');
  assert.equal(decision.fast_path, 'true');
  assert.equal(decision.heavy_jobs, 'false');
});

test('the land-first label is inert on a fork', () => {
  const decision = decide({
    labels: ['land-first'],
    head_repo: 'someone/else',
    additions: 3,
    deletions: 2,
    changed_paths: ['docs/guide.md'],
    low_risk_paths: ['docs/guide.md'],
  });
  assert.equal(decision.lane, 'normal');
  assert.equal(decision.tiny, 'false', 'a fork is never tiny either');
});

test('a sandbox author never takes the land-first lane', () => {
  const byLogin = decide({
    labels: ['land-first'],
    author: 'jacobs-agent-smith[bot]',
  });
  assert.equal(byLogin.lane, 'normal');
  const byBranch = decide({
    labels: ['land-first'],
    head_ref: 'agent/task-1',
  });
  assert.equal(byBranch.lane, 'normal');
});

test('the Renovate author takes the bot lane', () => {
  const decision = decide({ author: 'renovate[bot]' });
  assert.equal(decision.lane, 'bot');
  assert.equal(decision.fast_path, 'true');
  assert.equal(decision.heavy_jobs, 'false');
});

test('the release-please author takes the bot lane', () => {
  const decision = decide({ author: 'jacobpevans-release-please[bot]' });
  assert.equal(decision.lane, 'bot');
  assert.equal(decision.fast_path, 'true');
  assert.equal(decision.heavy_jobs, 'false');
});

test('the automation App takes the bot lane only with the auto-revert label', () => {
  const labeled = decide({
    author: 'jacobpevans-claude[bot]',
    labels: ['auto-revert'],
  });
  assert.equal(labeled.lane, 'bot');
  const unlabeled = decide({ author: 'jacobpevans-claude[bot]' });
  assert.equal(unlabeled.lane, 'normal');
});

test('a merge_group event resolves the pull request number from head_ref', () => {
  assert.equal(
    runStep('Resolve the pull request number', {
      EVENT_NAME: 'merge_group',
      PR_NUMBER: '',
      MERGE_HEAD_REF: 'refs/heads/gh-readonly-queue/main/pr-123-6f2a9b1c8d4e5f6a7b8c9d0e1f2a3b4c5d6e7f80',
    }),
    'pr_number=123',
  );
  assert.equal(
    runStep('Resolve the pull request number', {
      EVENT_NAME: 'pull_request',
      PR_NUMBER: '77',
      MERGE_HEAD_REF: '',
    }),
    'pr_number=77',
  );
  assert.equal(
    runStep('Resolve the pull request number', {
      EVENT_NAME: 'push',
      PR_NUMBER: '',
      MERGE_HEAD_REF: '',
    }),
    'pr_number=',
  );
});

test('a missing merge_tier property falls back to legacy', () => {
  assert.equal(
    runStep('Read the merge tier property', { MERGE_TIER: '' }),
    'tier=legacy',
  );
  assert.equal(
    runStep('Read the merge tier property', { MERGE_TIER: 'gold' }),
    'tier=gold',
  );
});
