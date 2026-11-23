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
  const regex = /^\/(.*)\/(i?)$/.exec(pattern);
  if (regex) {
    return new RegExp(regex[1], regex[2]).test(value);
  }

  const source = pattern.split('**')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
    .join('.*');
  return new RegExp(`^${source}$`, 'i').test(value);
}

function matchesPatterns(value, patterns) {
  const exclusions = patterns.filter((pattern) => pattern.startsWith('!'));
  const inclusions = patterns.filter((pattern) => !pattern.startsWith('!'));
  return !exclusions.some((pattern) => matchesPattern(value, pattern.slice(1))) &&
    (!inclusions.length || inclusions.some((pattern) => matchesPattern(value, pattern)));
}

function matchesPackageRule(rule, packageName, updateType, manager, { baseBranch, datasource, fileName, repository }) {
  if (rule.matchUpdateTypes && !rule.matchUpdateTypes.includes(updateType)) return false;
  if (rule.matchManagers && !rule.matchManagers.includes(manager)) return false;
  if (rule.matchDatasources && !rule.matchDatasources.includes(datasource)) return false;
  if (rule.matchBaseBranches && !matchesPatterns(baseBranch, rule.matchBaseBranches)) return false;
  if (rule.matchPackageNames && !matchesPatterns(packageName, rule.matchPackageNames)) return false;
  if (rule.matchFileNames && !matchesPatterns(fileName, rule.matchFileNames)) return false;
  return !rule.matchRepositories || matchesPatterns(repository, rule.matchRepositories);
}

function resolvePackagePolicy(packageName, updateType, manager, {
  baseBranch = 'main',
  datasource,
  fileName,
  repository = 'JacobPEvans/example',
} = {}) {
  return preset.packageRules
    .filter((rule) => matchesPackageRule(rule, packageName, updateType, manager, {
      baseBranch,
      datasource,
      fileName,
      repository,
    }))
    .reduce((policy, rule) => {
      for (const key of ['minimumReleaseAge', 'automerge', 'groupName', 'groupSlug', 'schedule', 'pinDigests',
        'separateMajorMinor', 'prPriority', 'semanticCommitType', 'semanticCommitScope']) {
        if (Object.hasOwn(rule, key)) policy[key] = rule[key];
      }
      policy.labels.push(...(rule.addLabels || []));
      policy.labels = [...new Set(policy.labels)];
      return policy;
    }, {
      minimumReleaseAge: preset.minimumReleaseAge,
      automerge: false,
      separateMajorMinor: preset.separateMajorMinor ?? true,
      labels: [],
    });
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

test('pre-commit hooks that install exact registry releases keep the seven-day hold', () => {
  for (const hook of ['astral-sh/ruff-pre-commit', 'DavidAnson/markdownlint-cli2', 'semgrep/pre-commit']) {
    assert.equal(resolvePackagePolicy(hook, 'minor', 'pre-commit').minimumReleaseAge, '7 days');
  }
  assert.equal(resolvePackagePolicy('pre-commit/pre-commit-hooks', 'minor', 'pre-commit').minimumReleaseAge, '0 days');
  assert.equal(resolvePackagePolicy('astral-sh/setup-uv', 'minor', 'github-actions').minimumReleaseAge, '0 days');
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
    const policy = resolvePackagePolicy('actions/checkout', updateType);
    assert.equal(policy.minimumReleaseAge, '0 days');
    assert.equal(policy.automerge, true);
    assert.deepEqual(policy.labels, []);
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

  const claudeCodeMajor = resolvePackagePolicy('@anthropic-ai/claude-code', 'major');
  assert.equal(claudeCodeMajor.minimumReleaseAge, '0 days');
  assert.equal(claudeCodeMajor.automerge, true);
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

test('first-party updates on any base branch auto-merge at any time, one PR per dependency', () => {
  const owners = [
    'JacobPEvans', 'JacobPEvans-ai', 'JacobPEvans-personal', 'dryvist', 'jpe-ai-agents', 'jpe-ansible', 'jpe-claude',
    'jpe-cribl', 'jpe-nix', 'jpe-openbao-plugin-secrets', 'jpe-private', 'jpe-splunk',
  ];
  const cases = [
    ['github-tags', 'major'], ['github-releases', 'minor'], ['github-tags', 'patch'],
    ['github-digest', 'digest'], ['github-tags', 'pin'], ['github-tags', 'pinDigest'],
  ];
  for (const owner of owners) {
    for (const baseBranch of ['develop', 'main']) {
      for (const [datasource, updateType] of cases) {
        for (const packageName of [`${owner}/.github`, `https://github.com/${owner.toUpperCase()}/tool`]) {
          const policy = resolvePackagePolicy(packageName, updateType, undefined, { baseBranch, datasource });
          assert.equal(policy.automerge, true, packageName);
          assert.equal(policy.minimumReleaseAge, '0 days', packageName);
          assert.deepEqual(policy.schedule, ['at any time'], packageName);
          assert.equal(policy.groupName, null, packageName);
          assert.equal(policy.prPriority, 10, packageName);
        }
      }
    }
  }
});

test('GitHub Actions dependency updates in workflow files use fix(deps) commits', () => {
  const workflowRule = findRule(
    preset,
    (rule) => rule.matchManagers?.includes('github-actions') && rule.matchFileNames?.includes('.github/workflows/**'),
    'classify workflow dependency updates as Release Please fixes',
  );
  assert.deepEqual(workflowRule.matchManagers, ['github-actions']);
  assert.deepEqual(workflowRule.matchFileNames, ['.github/workflows/**']);
  assert.deepEqual(workflowRule.matchRepositories, ['jpe-cribl/.github']);
  assert.equal(workflowRule.semanticCommitType, 'fix');
  assert.equal(workflowRule.semanticCommitScope, 'deps');

  const workflowPolicy = resolvePackagePolicy('actions/checkout', 'patch', 'github-actions', {
    fileName: '.github/workflows/release-reconciliation-canary.yml',
    repository: 'jpe-cribl/.github',
  });
  assert.equal(workflowPolicy.semanticCommitType, 'fix');
  assert.equal(workflowPolicy.semanticCommitScope, 'deps');

  const parentRepositoryPolicy = resolvePackagePolicy('actions/checkout', 'patch', 'github-actions', {
    fileName: '.github/workflows/release.yml',
    repository: 'JacobPEvans/.github',
  });
  assert.equal(parentRepositoryPolicy.semanticCommitType, undefined);
  assert.equal(parentRepositoryPolicy.semanticCommitScope, undefined);

  const nonWorkflowPolicy = resolvePackagePolicy('actions/checkout', 'patch', 'github-actions', {
    fileName: '.github/scripts/release.js',
    repository: 'jpe-cribl/.github',
  });
  assert.equal(nonWorkflowPolicy.semanticCommitType, undefined);
  assert.equal(nonWorkflowPolicy.semanticCommitScope, undefined);

  const nonActionPolicy = resolvePackagePolicy('example/package', 'patch', 'npm', {
    fileName: '.github/workflows/release-reconciliation-canary.yml',
    repository: 'jpe-cribl/.github',
  });
  assert.equal(nonActionPolicy.semanticCommitType, undefined);
  assert.equal(nonActionPolicy.semanticCommitScope, undefined);

  const unrelatedRepositoryPolicy = resolvePackagePolicy('actions/checkout', 'patch', 'github-actions', {
    fileName: '.github/workflows/release.yml',
    repository: 'dryvist/example',
  });
  assert.equal(unrelatedRepositoryPolicy.semanticCommitType, undefined);
  assert.equal(unrelatedRepositoryPolicy.semanticCommitScope, undefined);
});

test('the first-party rule matches only exact first-party owners', () => {
  for (const [packageName, datasource] of [
    ['jpe-lookalike/tool', 'github-tags'],
    ['JacobPEvans-ai-other/tool', 'github-tags'],
    ['jpe-cribl-extra/tool', 'github-releases'],
    ['https://example.com/jpe-cribl/tool', 'github-releases'],
    ['https://github.com.example.com/jpe-cribl/tool', 'github-releases'],
    ['jpe-cribl/tool/subpath', 'github-releases'],
  ]) {
    const policy = resolvePackagePolicy(packageName, 'major', undefined, { baseBranch: 'develop', datasource });
    assert.equal(policy.automerge, false, packageName);
    assert.equal(policy.minimumReleaseAge, '7 days', packageName);
    assert.equal(policy.schedule, undefined, packageName);
  }
});

test('the first-party rule preserves SHA pinning and manual-major repositories', () => {
  for (const baseBranch of ['develop', 'main']) {
    const digest = resolvePackagePolicy('dryvist/example', 'digest', 'github-actions', { baseBranch, datasource: 'github-digest' });
    assert.equal(digest.pinDigests, true);
    assert.equal(digest.automerge, true);
    assert.equal(digest.minimumReleaseAge, '0 days');
  }
  for (const repository of ['dryvist/ansible-example', 'dryvist/nix-ai']) {
    for (const baseBranch of ['develop', 'main']) {
      const options = { baseBranch, datasource: 'github-tags', repository };
      assert.equal(resolvePackagePolicy('jpe-cribl/.github', 'major', 'github-actions', options).automerge, false);
      assert.equal(resolvePackagePolicy('jpe-cribl/.github', 'minor', 'github-actions', options).automerge, true);
    }
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

test('lock-file maintenance opens on Saturday and merges no sooner than 24 hours later', () => {
  assert.deepEqual(preset.lockFileMaintenance.schedule, ['* 0-5 * * 6']);
  assert.deepEqual(preset.lockFileMaintenance.automergeSchedule, ['* 6-23 * * 0']);
  assert.equal(preset.lockFileMaintenance.automerge, true);
  assert.equal(nixPreset.lockFileMaintenance.automergeSchedule, undefined, 'the Nix preset inherits the window');
});

test('per-input flake updates need a release timestamp, so only first-party inputs get them', () => {
  const nixRule = findRule(
    nixPreset,
    (rule) => rule.matchManagers?.includes('nix') && rule.minimumReleaseAgeBehaviour !== undefined,
    'require timestamps for per-input flake updates',
  );
  assert.equal(nixRule.minimumReleaseAgeBehaviour, 'timestamp-required');
  assert.ok(!nixRule.matchUpdateTypes.includes('lockFileMaintenance'));
  assert.equal(nixRule.minimumReleaseAge, undefined, 'the rule must not change any release-age period');
  assert.equal(preset.internalChecksFilter, 'strict');
});

test('release-age exceptions are limited to first-party, trusted-org, vulnerability alerts, and Claude Code', () => {
  assert.equal(preset.vulnerabilityAlerts.minimumReleaseAge, '1 day');

  const firstParty = findRule(
    preset,
    (rule) => rule.description?.startsWith('First-party updates from the listed owners'),
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
      /^(JacobPEvans|dryvist|jpe-)/i.test(name.replace('https://github.com/', '')) ||
      (matchesPattern('jpe-cribl/.github', name) && rule.groupSlug === 'first-party-dependencies'),
    );
    assert.ok(Number(match[1]) >= 3 || isFirstParty || rule === claudeCode,
      `unapproved release-age exception in ${rule.description}`);
  }
});

test('the shared AI workflow stays on the v2 release line', () => {
  const rule = findRule(preset, (rule) => rule.allowedVersions
    && rule.matchPackageNames?.includes('JacobPEvans/.github-ai'), 'shared AI workflow release line');
  assert.deepEqual(rule.matchPackageNames, ['JacobPEvans/.github-ai']);
  assert.deepEqual(rule.matchManagers, ['github-actions']);

  const allowed = new RegExp(rule.allowedVersions.slice(1, -1));
  for (const version of ['v2', 'v2.15.0', '2.16.0']) assert.ok(allowed.test(version), version);
  for (const version of ['v3', 'v3.0.0', '20.1.0']) assert.ok(!allowed.test(version), version);
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
