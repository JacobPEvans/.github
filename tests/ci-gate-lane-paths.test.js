import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const load = (name) => JSON.parse(execFileSync(
  'python3',
  ['-c', 'import json, sys, yaml; print(json.dumps(yaml.load(sys.stdin, Loader=yaml.BaseLoader)))'],
  {
    input: readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8'),
    encoding: 'utf8',
  },
));

const gate = load('_ci-gate.yml');
const lane = load('_lane.yml');
const pathInputs = ['low_risk_paths', 'instruction_paths', 'guarded_paths'];

test('the gate forwards the three lane path lists to the classifier', () => {
  for (const name of pathInputs) {
    assert.equal(gate.jobs.lane.with[name], `\${{ inputs.${name} }}`);
  }
});

test('the gate repeats the classifier defaults for the lane path lists', () => {
  for (const name of pathInputs) {
    assert.equal(
      gate.on.workflow_call.inputs[name].default,
      lane.on.workflow_call.inputs[name].default,
      `${name} default matches _lane.yml`,
    );
  }
});
