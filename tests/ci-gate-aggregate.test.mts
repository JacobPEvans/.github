import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = fileURLToPath(new URL('../scripts/ci-gate-aggregate.mts', import.meta.url));

function runAggregator(jobs: object, allowedSkips = '', allowedFailures = '') {
  return spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CI_GATE_JOBS: JSON.stringify(jobs),
      CI_GATE_ALLOWED_SKIPS: allowedSkips,
      CI_GATE_ALLOWED_FAILURES: allowedFailures,
    },
  });
}

test('unknown results fail with the job name and result', () => {
  const run = runAggregator({ detect_changes: { result: 'abandoned' } });

  assert.equal(run.status, 1);
  assert.equal(run.stderr.trim(), 'Merge Gate failed: job "detect_changes" returned unknown result "abandoned".');
});

test('cancelled jobs remain named failures', () => {
  const run = runAggregator({ changes: { result: 'cancelled' } });

  assert.equal(run.status, 1);
  assert.equal(run.stderr.trim(), 'Merge Gate failed: job "changes" returned cancelled.');
});

test('a cancelled allowed skip remains a failure', () => {
  const run = runAggregator({ 'workflow-lint': { result: 'cancelled' } }, 'workflow-lint');

  assert.equal(run.status, 1);
  assert.equal(run.stderr.trim(), 'Merge Gate failed: job "workflow-lint" returned cancelled.');
});

test('successes and explicitly allowed skips and failures pass', () => {
  const run = runAggregator(
    {
      changes: { result: 'success' },
      lint: { result: 'skipped' },
      scope: { result: 'failure' },
    },
    'lint',
    'scope',
  );

  assert.equal(run.status, 0);
  assert.match(run.stdout, /Merge Gate passed/);
});

test('focused PR passes when ci succeeds and Molecule has no selected scenarios', () => {
  const run = runAggregator(
    {
      ci: { result: 'success' },
      molecule: { result: 'skipped' },
    },
    'molecule',
  );

  assert.equal(run.status, 0);
  assert.match(run.stdout, /Merge Gate passed: 2 jobs checked\./);
});

test('focused PR still fails if ci fails while Molecule has no selected scenarios', () => {
  const run = runAggregator(
    {
      ci: { result: 'failure' },
      molecule: { result: 'skipped' },
    },
    'molecule',
  );

  assert.equal(run.status, 1);
  assert.equal(run.stderr.trim(), 'Merge Gate failed: job "ci" returned failure.');
});
