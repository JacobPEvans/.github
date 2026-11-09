'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

const workflow = readFileSync(
  join(__dirname, '../.github/workflows/_ansible-ci.yml'),
  'utf8',
);

const ansibleLintStart = workflow.indexOf('  ansible-lint:\n');
const moleculeStart = workflow.indexOf('\n  molecule:\n', ansibleLintStart);
const tokenLimitsStart = workflow.indexOf('\n  token-limits:\n', moleculeStart);
assert.notEqual(ansibleLintStart, -1, 'Ansible lint job is present');
assert.notEqual(moleculeStart, -1, 'Molecule job follows Ansible lint');
assert.notEqual(tokenLimitsStart, -1, 'Token limits job follows Molecule');
const ansibleLint = workflow.slice(ansibleLintStart, moleculeStart);
const molecule = workflow.slice(moleculeStart, tokenLimitsStart);

// Evaluates a Galaxy install step's `if:` for a cache state and a
// requirements.yml digest, so the tests assert when the step runs rather than
// how the expression is spelled.
function runsWhen(slice, { cacheHit, requirements }) {
  const expr = slice
    .match(/^\s*if: \$\{\{ (.*) \}\}\s*$/m)[1]
    .replace('steps.galaxy-cache.outputs.cache-hit', JSON.stringify(cacheHit))
    .replace("hashFiles('requirements.yml')", JSON.stringify(requirements));
  return new Function(`return (${expr});`)();
}

const GALAXY_STATES = [
  { cacheHit: 'false', requirements: 'digest', runs: true },
  { cacheHit: 'true', requirements: 'digest', runs: false },
  { cacheHit: 'false', requirements: '', runs: false },
];

test('reconciles a restored Galaxy cache against current requirements before lint', () => {
  const cacheStart = ansibleLint.indexOf('- name: Cache Ansible Galaxy content');
  const collectionsStart = ansibleLint.indexOf('- name: Install Ansible collections');
  const rolesStart = ansibleLint.indexOf('- name: Install Ansible roles');
  const lintActionStart = ansibleLint.indexOf('uses: ansible/ansible-lint@');

  assert.ok(cacheStart >= 0, 'Ansible lint job caches Galaxy content');
  assert.ok(collectionsStart > cacheStart, 'collection install follows cache restore');
  assert.ok(rolesStart > collectionsStart, 'role install follows collection install');
  assert.ok(lintActionStart > rolesStart, 'ansible-lint runs after dependency reconciliation');
  assert.match(ansibleLint.slice(cacheStart, collectionsStart), /id: galaxy-cache/);
  assert.match(ansibleLint.slice(cacheStart, collectionsStart), /restore-keys:/);

  for (const [start, end, command] of [
    [collectionsStart, rolesStart, 'ansible-galaxy collection install'],
    [rolesStart, lintActionStart, 'ansible-galaxy role install'],
  ]) {
    const step = ansibleLint.slice(start, end);
    for (const state of GALAXY_STATES) {
      assert.equal(runsWhen(step, state), state.runs, JSON.stringify(state));
    }
    assert.ok(step.includes(`command: ${command} -r requirements.yml --force`));
  }
});

test('uses a fresh, versioned Galaxy cache namespace in both jobs', () => {
  const versionedKey = "key: ansible-galaxy-v2-${{ runner.os }}-${{ hashFiles('requirements.yml') }}";
  const versionedRestoreKey = 'ansible-galaxy-v2-${{ runner.os }}-';
  const legacyPrefix = 'ansible-galaxy-${{ runner.os }}-';

  assert.equal(workflow.split(versionedKey).length - 1, 2);
  assert.ok(ansibleLint.includes(versionedRestoreKey));
  assert.equal(workflow.includes(legacyPrefix), false);
});

test('installs current Galaxy dependencies after a Molecule cache miss', () => {
  const collectionsStart = molecule.indexOf('- name: Install Ansible collections');
  const rolesStart = molecule.indexOf('- name: Install Ansible roles');
  const moleculeTestStart = molecule.indexOf('run: molecule test');

  assert.ok(collectionsStart >= 0);
  assert.ok(rolesStart > collectionsStart);
  assert.ok(moleculeTestStart > rolesStart);

  for (const [start, end, command] of [
    [collectionsStart, rolesStart, 'ansible-galaxy collection install'],
    [rolesStart, moleculeTestStart, 'ansible-galaxy role install'],
  ]) {
    const step = molecule.slice(start, end);
    for (const state of GALAXY_STATES) {
      assert.equal(runsWhen(step, state), state.runs, JSON.stringify(state));
    }
    assert.ok(step.includes(`command: ${command} -r requirements.yml --force`));
  }
});
