const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const load = (name) => {
  const text = readFileSync(join(root, '.github', 'workflows', name), 'utf8');
  const parsed = JSON.parse(execFileSync(
    'python3',
    ['-c', 'import json, sys, yaml; print(json.dumps(yaml.load(sys.stdin, Loader=yaml.BaseLoader)))'],
    { input: text, encoding: 'utf8' },
  ));
  return { text, parsed };
};

const gateWorkflow = load('_ci-gate.yml');
const gate = gateWorkflow.parsed.jobs.gate;
const step = (name) => gate.steps.find((entry) => entry.name === name);
const names = (list) => String(list).split(',').map((name) => name.trim()).filter(Boolean);
const FAST_LANE = "${{ github.event_name == 'pull_request' && (needs.lane.outputs.lane == 'tiny' || needs.lane.outputs.lane == 'land-first') }}";

test('both gates aggregate with alls-green pinned to the v1.3.0 commit, and the script is gone', () => {
  for (const name of ['_ci-gate.yml', '_ansible-ci.yml']) {
    const { text } = load(name);
    assert.match(text, /uses: re-actors\/alls-green@b5b5b37504aa4183270bd3d855c52a67f212be35 # v1\.3\.0$/m, name);
    assert.match(text, /jobs: \$\{\{ toJSON\(needs\) \}\}/, name);
    assert.doesNotMatch(text, /ci-gate-aggregate/, name);
  }
  assert.equal(existsSync(join(root, 'scripts', 'ci-gate-aggregate.mts')), false);
});

test('every needed job is either required or named in allowed-skips, and no unknown job is named', () => {
  const aggregate = step('Aggregate results');
  const skips = names(aggregate.with['allowed-skips']);
  for (const name of skips) assert.ok(gate.needs.includes(name), `${name} is a needed job`);
  // These always run, so a skip of one of them fails the gate.
  for (const name of ['changes', 'scope', 'lane', 'uses-resolve']) {
    assert.ok(gate.needs.includes(name), `${name} is needed`);
    assert.ok(!skips.includes(name), `${name} may not skip`);
  }
  assert.deepEqual(names(aggregate.with['allowed-failures']), ['scope', 'lane']);
});

test('a fast-lane pull request is labelled checks:deferred with an App token after the aggregate passed', () => {
  const order = gate.steps.map((entry) => entry.name);
  const mint = step('Mint the App token for the deferred-check label');
  const label = step('Label the pull request checks:deferred');
  assert.ok(order.indexOf('Aggregate results') < order.indexOf(mint.name));
  assert.ok(order.indexOf(mint.name) < order.indexOf(label.name));
  // No always(): a failed aggregate stops the job before the label.
  assert.equal(mint.if, FAST_LANE);
  assert.equal(label.if, FAST_LANE);
  assert.equal(mint.with['permission-pull-requests'], 'write');
  assert.match(label.uses, /^actions\/github-script@[0-9a-f]{40}$/);
  assert.equal(label.with['github-token'], '${{ steps.deferred-token.outputs.token }}');
  assert.match(label.with.script, /issues\.addLabels\(/);
  assert.match(label.with.script, /issue_number: context\.payload\.pull_request\.number/);
  assert.match(label.with.script, /labels: \['checks:deferred'\]/);
  // The gate job itself asks for no write scope, so existing callers keep working.
  assert.equal(gate.permissions['pull-requests'], undefined);
});

test('the lane classifier grants the fast lanes only when the App key is set', () => {
  const lane = load('_lane.yml');
  assert.equal(lane.parsed.on.workflow_call.secrets.AUTOMATION_APP_PRIVATE_KEY.required, 'false');
  assert.equal(lane.parsed.jobs.classify.env.HAS_APP_KEY, "${{ secrets.AUTOMATION_APP_PRIVATE_KEY != '' }}");
  assert.match(lane.text, /^          TIER: \$\{\{ env\.HAS_APP_KEY == 'true' && steps\.tier\.outputs\.tier \|\| 'legacy' \}\}$/m);
  // The tier output itself stays the repository's real tier.
  assert.equal(lane.parsed.jobs.classify.outputs.tier, '${{ steps.tier.outputs.tier }}');
  assert.equal(gateWorkflow.parsed.jobs.lane.secrets.AUTOMATION_APP_PRIVATE_KEY, '${{ secrets.AUTOMATION_APP_PRIVATE_KEY }}');
});
