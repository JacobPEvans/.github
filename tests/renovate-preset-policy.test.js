'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');

const preset = JSON.parse(readFileSync('renovate-presets.json', 'utf8'));
const nixPreset = JSON.parse(readFileSync('renovate-nix.json', 'utf8'));

function findRule(config, predicate, description) {
  const rule = config.packageRules.find(predicate);
  assert.ok(rule, `missing policy rule: ${description}`);
  return rule;
}

test('npm updates respect the seven-day release age and avoid unsafe lock maintenance', () => {
  assert.equal(preset.minimumReleaseAge, '7 days');
  assert.equal(preset.internalChecksFilter, 'strict');

  const npmLockRule = findRule(
    preset,
    (rule) => rule.matchManagers?.includes('npm') && rule.matchUpdateTypes?.includes('lockFileMaintenance'),
    'disable npm lock-file maintenance',
  );
  assert.equal(npmLockRule.enabled, false);
});

test('Terraform lock maintenance cannot move provider locks past declared pins', () => {
  const terraformLockRule = findRule(
    preset,
    (rule) => rule.matchManagers?.includes('terraform') && rule.matchUpdateTypes?.includes('lockFileMaintenance'),
    'disable Terraform lock-file maintenance',
  );
  assert.equal(terraformLockRule.enabled, false);
});

test('Nix repos raise Go directives in a dedicated review-required PR', () => {
  assert.equal(nixPreset.gomod.enabled, true);
  assert.equal(nixPreset.nix.enabled, true);

  const goDirectiveRule = findRule(
    nixPreset,
    (rule) => rule.matchManagers?.includes('gomod') && rule.matchDepTypes?.includes('golang'),
    'bump Go minimum-version directives',
  );
  const goToolchainRule = findRule(
    nixPreset,
    (rule) => rule.matchManagers?.includes('gomod') && rule.matchDepTypes?.includes('toolchain'),
    'isolate Go toolchain directive updates',
  );
  assert.equal(goDirectiveRule.matchDepNames[0], 'go');
  assert.equal(goDirectiveRule.rangeStrategy, 'bump');
  assert.equal(goDirectiveRule.groupName, 'Go toolchain');
  assert.equal(goToolchainRule.groupName, goDirectiveRule.groupName);
  assert.equal(nixPreset.lockFileMaintenance.groupName, 'Nix lock file maintenance');
  for (const rule of [goDirectiveRule, goToolchainRule]) {
    assert.equal(rule.minimumReleaseAge, null);
    assert.equal(rule.automerge, false);
  }
});
