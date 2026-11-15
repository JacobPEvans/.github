import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflowText = readFileSync(
  new URL('../.github/workflows/_ci-gate.yml', import.meta.url),
  'utf8',
);

const workflow = JSON.parse(execFileSync(
  'python3',
  ['-c', 'import json, sys, yaml; print(json.dumps(yaml.load(sys.stdin, Loader=yaml.BaseLoader)))'],
  { input: workflowText, encoding: 'utf8' },
));

test('the gate classifies the lane with the shared reusable workflow', () => {
  const lane = workflow.jobs.lane;
  assert.ok(lane, 'lane job exists');
  assert.equal(lane.uses, './.github/workflows/_lane.yml');
  assert.equal(lane.name, 'Classify Lane');
});

test('lane, tier, heavy_jobs and the fast_path alias are exported from the classifier', () => {
  for (const output of ['lane', 'tier', 'heavy_jobs', 'fast_path']) {
    const declaration = workflow.on.workflow_call.outputs[output];
    assert.ok(declaration, `${output} output exists`);
    assert.match(
      declaration.value,
      new RegExp(`\\$\\{\\{ jobs\\.lane\\.outputs\\.${output} \\}\\}`),
      `${output} is wired from the lane job`,
    );
  }
  assert.match(workflow.on.workflow_call.outputs.fast_path.description, /contract shards or a site build/);
  assert.match(workflow.on.workflow_call.outputs.fast_path.description, /fast_path != 'true'/);
});

test('fast-path skips only the opted-in Nix build and Molecule suite', () => {
  assert.match(workflow.jobs['nix-build'].if, /needs\.lane\.outputs\.fast_path != 'true'/);
  assert.ok(workflow.jobs['nix-build'].needs.includes('lane'), 'nix-build waits for the lane');
  assert.match(workflow.jobs['ansible-ci'].with.molecule, /needs\.lane\.outputs\.fast_path != 'true'/);
  assert.ok(workflow.jobs['ansible-ci'].needs.includes('lane'), 'ansible-ci waits for the lane');

  for (const jobName of ['zizmor', 'workflow-lint', 'markdown-lint', 'repo-tests']) {
    assert.doesNotMatch(
      JSON.stringify(workflow.jobs[jobName]),
      /fast_path/,
      `${jobName} remains independent of fast-path`,
    );
  }
});

test('the gate keeps no fast-path decision logic of its own', () => {
  assert.doesNotMatch(workflowText, /fast_path_decision/);
  const tier = workflow.jobs.changes.steps.find((step) => step.id === 'tier');
  assert.ok(tier, 'tier step still selects the event tier');
  assert.doesNotMatch(JSON.stringify(tier), /fast_path/);
  assert.ok(!('fast_path' in workflow.jobs.changes.outputs), 'changes job no longer exports fast_path');
});
