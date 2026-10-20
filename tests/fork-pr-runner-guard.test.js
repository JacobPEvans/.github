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
