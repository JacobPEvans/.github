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

const tier = workflow.jobs.changes.steps.find((step) => step.id === 'tier');
const fastPathFunction = tier.run.match(/fast_path_decision\(\) \{[\s\S]*?\n\}/)?.[0];

function decide({ event = 'pull_request', label, additions, deletions, files }) {
  assert.ok(fastPathFunction, 'tier step defines fast_path_decision');
  return execFileSync(
    'bash',
    [
      '-c',
      `${fastPathFunction}\nfast_path_decision "$1" "$2" "$3" "$4" "$5"`,
      'test',
      event,
      label,
      String(additions),
      String(deletions),
      String(files),
    ],
    { encoding: 'utf8' },
  );
}

test('fast-path uses current pull request metadata and enforces both size limits', () => {
  assert.match(tier.run, /gh api "repos\/\$REPO\/pulls\/\$PR_NUMBER"/);
  assert.doesNotMatch(JSON.stringify(tier), /github\.event\.pull_request\.labels/);
  assert.match(tier.run, /-lt 15/);
  assert.match(tier.run, /-lt 5/);
});

test('fast-path skips only the opted-in Nix build and Molecule suite', () => {
  assert.match(workflow.jobs['nix-build'].if, /needs\.changes\.outputs\.fast_path != 'true'/);
  assert.match(workflow.jobs['ansible-ci'].with.molecule, /needs\.changes\.outputs\.fast_path != 'true'/);

  for (const jobName of ['zizmor', 'workflow-lint', 'markdown-lint', 'repo-tests']) {
    assert.doesNotMatch(
      JSON.stringify(workflow.jobs[jobName]),
      /fast_path/,
      `${jobName} remains independent of fast-path`,
    );
  }
});

test('fast_path is exported to reusable workflow callers', () => {
  const output = workflow.on.workflow_call.outputs.fast_path;
  assert.ok(output, 'workflow_call output exists');
  assert.match(output.value, /jobs\.changes\.outputs\.fast_path/);
  assert.match(output.description, /contract shards or a site build/);
  assert.match(output.description, /fast_path != 'true'/);
});

test('fast_path requires the label, fewer than 15 lines, and fewer than 5 files', () => {
  assert.equal(decide({ label: 'true', additions: 7, deletions: 7, files: 4 }), 'true');
  assert.equal(decide({ label: 'true', additions: 8, deletions: 7, files: 4 }), 'false');
  assert.equal(decide({ label: 'true', additions: 7, deletions: 7, files: 5 }), 'false');
  assert.equal(decide({ label: 'false', additions: 7, deletions: 7, files: 4 }), 'false');
  assert.equal(decide({ event: 'push', label: 'true', additions: 7, deletions: 7, files: 4 }), 'false');
});
