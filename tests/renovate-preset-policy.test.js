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

function matchesPattern(value, pattern) {
  if (pattern.startsWith('/') && pattern.endsWith('/')) {
    return new RegExp(pattern.slice(1, -1)).test(value);
  }

  const source = pattern.split('**')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
    .join('.*');
  return new RegExp(`^${source}$`).test(value);
}

function matchesPackageRule(rule, packageName, updateType, repository) {
  if (rule.matchUpdateTypes && !rule.matchUpdateTypes.includes(updateType)) return false;

  if (rule.matchPackageNames) {
    const patterns = rule.matchPackageNames.map((pattern) => ({
      exclude: pattern.startsWith('!'),
      value: pattern.replace(/^!/, ''),
    }));
    const exclusions = patterns.filter((pattern) => pattern.exclude);
    const inclusions = patterns.filter((pattern) => !pattern.exclude);
    if (exclusions.some((pattern) => matchesPattern(packageName, pattern.value))) return false;
    if (inclusions.length && !inclusions.some((pattern) => matchesPattern(packageName, pattern.value))) return false;
  }

  if (rule.matchRepositories && !rule.matchRepositories.some((pattern) => matchesPattern(repository, pattern))) {
    return false;
  }

  return true;
}

function resolvePackagePolicy(packageName, updateType) {
  const repository = 'JacobPEvans/example';
  return preset.packageRules
    .filter((rule) => matchesPackageRule(rule, packageName, updateType, repository))
    .reduce((policy, rule) => {
      for (const key of ['minimumReleaseAge', 'automerge']) {
        if (Object.hasOwn(rule, key)) policy[key] = rule[key];
      }
      policy.labels.push(...(rule.addLabels || []));
      policy.labels = [...new Set(policy.labels)];
      return policy;
    }, { minimumReleaseAge: preset.minimumReleaseAge, automerge: false, labels: [] });
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

test('timestamp-less lock and digest updates retain the configured release-age periods', () => {
  const timestampRule = findRule(
    preset,
    (rule) => rule.matchUpdateTypes?.includes('lockFileMaintenance') &&
      rule.matchUpdateTypes?.includes('digest'),
    'allow timestamp-less lock maintenance and digest updates',
  );
  assert.deepEqual(timestampRule.matchUpdateTypes, ['lockFileMaintenance', 'digest']);
  assert.equal(timestampRule.minimumReleaseAgeBehaviour, 'timestamp-optional');
  assert.equal(timestampRule.minimumReleaseAge, undefined);
  assert.equal(preset.minimumReleaseAge, '7 days');

  const digestAgeRule = findRule(
    preset,
    (rule) => rule.matchUpdateTypes?.includes('digest') && rule.minimumReleaseAge,
    'keep the release-age hold for dated digest updates',
  );
  assert.equal(digestAgeRule.minimumReleaseAge, '7 days');
  const majorAgeRule = findRule(
    preset,
    (rule) => rule.matchUpdateTypes?.includes('major') && !rule.matchPackageNames && rule.minimumReleaseAge,
    'restore the release-age hold for major updates',
  );
  assert.equal(majorAgeRule.minimumReleaseAge, '7 days');
  assert.equal(majorAgeRule.automerge, undefined);
});

test('trusted-org updates use zero-day non-major and seven-day major policies', () => {
  const trustedOrgRule = findRule(
    preset,
    (rule) => rule.description?.startsWith('Auto-merge trusted-org updates'),
    'trusted-org auto-merge policy',
  );
  assert.equal(trustedOrgRule.matchUpdateTypes, undefined);
  assert.equal(trustedOrgRule.automerge, true);
  assert.equal(trustedOrgRule.minimumReleaseAge, '0 days');
  assert.equal(
    preset.packageRules.filter((rule) =>
      JSON.stringify(rule.matchPackageNames) === JSON.stringify(trustedOrgRule.matchPackageNames)).length,
    1,
  );

  for (const updateType of ['minor', 'digest']) {
    assert.deepEqual(resolvePackagePolicy('actions/checkout', updateType), {
      minimumReleaseAge: '0 days',
      automerge: true,
      labels: [],
    });
  }

  const trustedMajor = resolvePackagePolicy('actions/checkout', 'major');
  assert.equal(trustedMajor.minimumReleaseAge, '7 days');
  assert.equal(trustedMajor.automerge, true);
  assert.ok(trustedMajor.labels.includes('dep:review'));
  assert.ok(trustedMajor.labels.includes('update:major'));

  const otherMajor = resolvePackagePolicy('lodash', 'major');
  assert.equal(otherMajor.minimumReleaseAge, '7 days');
  assert.equal(otherMajor.automerge, false);
  assert.ok(otherMajor.labels.includes('dep:review'));

  const firstPartyMajor = resolvePackagePolicy('dryvist/example', 'major');
  assert.equal(firstPartyMajor.minimumReleaseAge, '0 days');
  assert.equal(firstPartyMajor.automerge, true);
});

test('majors never ride in the grouped PR', () => {
  const grouping = JSON.parse(readFileSync('renovate-grouping.json', 'utf8'));
  for (const config of [preset, grouping]) {
    assert.ok(config.extends.includes('group:allNonMajor'));
    assert.ok(!config.extends.includes('group:all'));
    const digestRule = findRule(
      config,
      (rule) => rule.matchUpdateTypes?.includes('digest') && rule.matchUpdateTypes?.includes('pinDigest'),
      'group digest and pin updates with the non-major PR',
    );
    assert.deepEqual(digestRule.matchUpdateTypes, ['digest', 'pin', 'pinDigest']);
    assert.equal(digestRule.groupName, 'all non-major dependencies');
    assert.equal(digestRule.groupSlug, 'all-minor-patch');
  }
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

test('release-age exceptions are limited to first-party, trusted-org, vulnerability alerts, and Claude Code', () => {
  assert.equal(preset.vulnerabilityAlerts.minimumReleaseAge, '1 day');

  const firstParty = findRule(
    preset,
    (rule) => rule.matchPackageNames?.includes('jpe-nix/**'),
    'first-party zero-day rule',
  );
  assert.equal(firstParty.minimumReleaseAge, '0 days');

  const claudeCode = findRule(
    preset,
    (rule) => rule.matchPackageNames?.includes('@anthropic-ai/claude-code'),
    'Claude Code zero-day exception',
  );
  assert.equal(claudeCode.minimumReleaseAge, '0 days');

  const trustedOrg = findRule(
    preset,
    (rule) => rule.description?.startsWith('Auto-merge trusted-org updates'),
    'trusted-org zero-day rule',
  );
  assert.equal(trustedOrg.minimumReleaseAge, '0 days');

  for (const rule of preset.packageRules) {
    if (!rule.minimumReleaseAge) continue;
    const match = /^(\d+) days$/.exec(rule.minimumReleaseAge);
    assert.ok(match, `unexpected minimumReleaseAge: ${rule.minimumReleaseAge}`);
    const isFirstParty = rule === firstParty || rule === trustedOrg || rule.matchPackageNames?.some((name) =>
      /^(JacobPEvans|dryvist|jpe-)/i.test(name.replace('https://github.com/', '')),
    );
    assert.ok(Number(match[1]) >= 3 || isFirstParty || rule === claudeCode,
      `unapproved release-age exception in ${rule.description}`);
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
