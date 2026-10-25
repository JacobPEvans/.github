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

test('Molecule scenario image annotations track the annotated tag and digest', () => {
  const manager = preset.customManagers.find((m) => m.managerFilePatterns?.some((p) => p.includes('molecule')));
  assert.ok(manager, 'missing Molecule image customManager');
  assert.equal(manager.versioningTemplate, 'docker');

  const pathRegex = new RegExp(manager.managerFilePatterns[0].slice(1, -1));
  assert.ok(pathRegex.test('molecule/openbao/molecule.yml'));
  assert.ok(!pathRegex.test('molecule/openbao/converge.yml'));

  const matchRegex = new RegExp(manager.matchStrings[0]);
  const digest = '0123456789abcdef'.repeat(4);
  const image = 'registry.example.com/team/image';
  const plain = `    # renovate: datasource=docker depName=${image}\n    image: ${image}:1.2.3@sha256:${digest}\n`;
  const folded = `    # renovate: datasource=docker depName=${image}\n    image: >-\n      ${image}:1.2.4@sha256:${digest}\n`;
  const unannotated = `    image: ${image}:1.2.3@sha256:${digest}\n`;
  const portRegistry = `    # renovate: datasource=docker depName=${image}\n    image: registry.example.com:5000/team/image:1.2.5@sha256:${digest}\n`;

  const plainMatch = matchRegex.exec(plain);
  assert.equal(plainMatch.groups.datasource, 'docker');
  assert.equal(plainMatch.groups.depName, image);
  assert.equal(plainMatch.groups.currentValue, '1.2.3');
  assert.equal(plainMatch.groups.currentDigest, `sha256:${digest}`);

  const foldedMatch = matchRegex.exec(folded);
  assert.equal(foldedMatch.groups.currentValue, '1.2.4');
  assert.equal(foldedMatch.groups.currentDigest, `sha256:${digest}`);

  assert.equal(matchRegex.exec(unannotated), null);
  assert.equal(matchRegex.exec(portRegistry).groups.currentValue, '1.2.5');
});
