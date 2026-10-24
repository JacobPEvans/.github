import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const workflowsDir = fileURLToPath(new URL('../.github/workflows/', import.meta.url));

// A reusable workflow declares `workflow_call:` under `on:` (two-space indent).
const readWorkflow = (name) => readFileSync(`${workflowsDir}${name}`, 'utf8');
const workflows = readdirSync(workflowsDir).filter((name) => name.endsWith('.yml'));
const reusables = workflows.filter((name) => /^ {2}workflow_call:/m.test(readWorkflow(name)));

test('the scan finds the shared gate and Cribl pack validator among the reusable workflows', () => {
  for (const name of ['_ci-gate.yml', '_cribl-pack-validate.yml']) {
    assert.ok(reusables.includes(name), `reusables found: ${reusables.join(', ')}`);
  }
});

// The top-level concurrency block of a workflow, or null when it has none.
function topLevelConcurrency(text) {
  const match = text.match(/^concurrency:\n((?:  .*\n?)+)/m);
  return match ? match[1] : null;
}

// Why a reusable's top-level concurrency block is unsafe, or null when allowed.
// Allowed: a non-cancelling lock whose group does not reference github.workflow.
function concurrencyProblem(block) {
  const group = block.match(/^  group:\s*(.*)$/m)?.[1] ?? '';
  const cancel = block.match(/^  cancel-in-progress:\s*(.*)$/m)?.[1]?.trim() ?? '';
  if (cancel !== 'false') {
    return `cancel-in-progress is "${cancel || 'unset'}", so a cancelling group cancels sibling calls in one caller run`;
  }
  if (group.includes('github.workflow')) {
    return "the group references github.workflow, which collides with the caller's own group and deadlocks";
  }
  return null;
}

test('a reusable workflow carries a concurrency block only as a non-cancelling, repository-keyed lock', () => {
  const offenders = [];
  for (const name of reusables) {
    const block = topLevelConcurrency(readWorkflow(name));
    const problem = block === null ? null : concurrencyProblem(block);
    if (problem) offenders.push(`${name}: ${problem}`);
  }
  assert.deepEqual(offenders, [], `top-level concurrency rejected:\n${offenders.join('\n')}`);
});

test('the concurrency rule rejects a cancelling group and a github.workflow group', () => {
  assert.match(concurrencyProblem('  group: x\n  cancel-in-progress: true\n'), /cancels sibling calls/);
  assert.match(
    concurrencyProblem('  group: y-${{ github.workflow }}\n  cancel-in-progress: false\n'),
    /deadlocks/,
  );
  assert.equal(
    concurrencyProblem('  group: flake-lock-${{ github.repository }}\n  cancel-in-progress: false\n'),
    null,
  );
});

test('ansible_lint_args is declared on the gate and forwarded to lint_args', () => {
  const gate = readWorkflow('_ci-gate.yml');
  assert.match(gate, /^ {6}ansible_lint_args:$/m);
  assert.match(gate, /^ {6}lint_args: \$\{\{ inputs\.ansible_lint_args \}\}$/m);
});

test('flake lock freshness is optional and included in the merge gate', () => {
  const gate = readWorkflow('_ci-gate.yml');
  assert.match(
    gate,
    /^      flake_lock_max_age_days:\n(?:        .*\n)*?        type: number\n(?:        .*\n)*?        default: 0$/m,
  );
  assert.match(
    gate,
    /^  flake-lock-fresh:\n    name: Flake Lock Fresh\n    if: \$\{\{ inputs\.flake_lock_max_age_days > 0 \}\}\n    permissions:\n      contents: read\n    uses: dryvist\/\.github\/\.github\/workflows\/_flake-lock-fresh\.yml@[0-9a-f]{40} # PR #426 merge commit\n    with:\n      max_age_days: \$\{\{ inputs\.flake_lock_max_age_days \}\}$/m,
  );
  assert.match(gate, /^    needs: \[.*\bflake-lock-fresh\b.*\]$/m);
  assert.match(gate, /^          CI_GATE_ALLOWED_SKIPS: >-\n(?:^            .*\n)*?^            .*flake-lock-fresh/m);
});
