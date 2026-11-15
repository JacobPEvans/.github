import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function parseWorkflow(path) {
  return JSON.parse(execFileSync(
    'python3',
    ['-c', 'import json, sys, yaml; print(json.dumps(yaml.load(sys.stdin, Loader=yaml.BaseLoader)))'],
    { input: readFileSync(new URL(path, import.meta.url), 'utf8'), encoding: 'utf8' },
  ));
}

const workflow = parseWorkflow('../.github/workflows/_ci-gate.yml');

test('the full tier keeps the whole default Python version array', () => {
  const versions = JSON.parse(workflow.on.workflow_call.inputs.python_ci_versions.default);
  assert.equal(versions.length, 5);
  assert.deepEqual(versions, ['3.10', '3.11', '3.12', '3.13', '3.14']);
});

test('a non-full-tier pull request runs the ends of the default Python range', () => {
  const expression = workflow.jobs['python-ci'].with.python_versions;
  // PR + relevance (or lint-only): the narrow array. Everything else — other
  // events, the full tier, a caller-supplied array — falls through to the
  // caller's input, i.e. the behaviour before the narrow array existed.
  assert.match(
    expression,
    /github\.event_name == 'pull_request' && needs\.lane\.outputs\.tier != 'legacy' && needs\.changes\.outputs\.test_tier != 'full' && '\["3\.10","3\.14"\]' \|\| inputs\.python_ci_versions/,
  );
  const narrow = JSON.parse(expression.match(/'(\["3\.10","3\.14"\])'/)[1]);
  const versions = JSON.parse(workflow.on.workflow_call.inputs.python_ci_versions.default);
  assert.deepEqual(narrow, [versions[0], versions[versions.length - 1]]);
});

test('the Python job waits for the lane classifier, which supplies the tier', () => {
  assert.ok(workflow.jobs['python-ci'].needs.includes('lane'));
});
