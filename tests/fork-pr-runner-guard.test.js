'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');

const GUARD = '!github.event.pull_request || github.event.pull_request.head.repo.full_name == github.repository';

for (const file of [
  '.github/workflows/_ci-gate.yml',
  '.github/workflows/_ansible-ci.yml',
  '.github/workflows/_ansible-changes.yml',
]) {
  test(`${file}: every caller-selected runner is guarded for any event that carries a pull request`, () => {
    const text = readFileSync(file, 'utf8');
    const flat = text.replace(/\n\s*/g, ' ');
    assert.doesNotMatch(flat, /\(github\.event_name != 'pull_request' \|\| github\.event\.pull_request\.head/);
    const selectors = text
      .split('\n')
      .filter((line) => /^\s+runs-on: \$\{\{.*inputs\.\w*(runner|label)/.test(line));
    for (const line of selectors) {
      assert.ok(line.includes(GUARD), `unguarded runner selector: ${line.trim()}`);
    }
  });
}

test('_ci-gate.yml: light checks take light_runner_label, falling back to runner_label', () => {
  const text = readFileSync('.github/workflows/_ci-gate.yml', 'utf8');
  const jobs = text.split(/\n(?=  [a-z0-9_-]+:\n)/);
  const light = ['markdown-lint', 'file-size', 'token-limits', 'zizmor', 'agent-patch-guard', 'agent-pr-body',
    'renovate-annotations'];
  for (const name of light) {
    const block = jobs.find((j) => j.startsWith(`  ${name}:\n`));
    assert.ok(block, `job ${name} not found`);
    assert.ok(block.includes(`${GUARD}) && (inputs.light_runner_label || inputs.runner_label) ||`),
      `${name} does not route through light_runner_label`);
  }
  const heavy = jobs.filter((j) => /^ {2}(tofu-ci|ansible-ci|python-ci|repo-tests):\n/.test(j));
  assert.equal(heavy.length, 4);
  for (const block of heavy) assert.ok(!block.includes('light_runner_label'));
});
