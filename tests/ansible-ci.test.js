'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const test = require('node:test');

const ansibleCi = readFileSync('.github/workflows/_ansible-ci.yml', 'utf8');
const renovateValidator = readFileSync('.github/workflows/renovate-config-validate.yml', 'utf8');
const renovatePreset = JSON.parse(readFileSync('renovate-presets.json', 'utf8'));

function tinyRunScript() {
  const step = ansibleCi.slice(ansibleCi.indexOf('- name: Detect tiny develop pull request'));
  const run = step.match(/\n        run: \|\n((?: {10}[^\n]*(?:\n|$))*)/);
  assert.ok(run, 'tiny output step has an inline run script');
  return run[1]
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(10))
    .join('\n');
}

function runTiny(overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ansible-ci-tiny-'));
  const output = join(directory, 'github-output');
  execFileSync('bash', ['-e', '-c', tinyRunScript()], {
    env: {
      PATH: process.env.PATH,
      GITHUB_OUTPUT: output,
      EVENT_NAME: 'pull_request',
      BASE_REF: 'develop',
      CHANGED_FILES: '2',
      ADDITIONS: '2',
      DELETIONS: '0',
      ALLOWED_FILES: '2',
      EXCLUDED_FILES: '0',
      ...overrides,
    },
  });
  return readFileSync(output, 'utf8').trim();
}

function jobRuns(jobName, lint) {
  const start = ansibleCi.indexOf(`\n  ${jobName}:\n`);
  assert.notEqual(start, -1, `${jobName} job exists`);
  const rest = ansibleCi.slice(start + 1);
  const nextJob = /\n  [a-zA-Z][\w-]*:\n/.exec(rest.slice(1));
  const job = rest.slice(0, nextJob ? nextJob.index + 1 : undefined);
  const condition =
    job.match(/^ {4}if: \$\{\{([\s\S]*?)\}\}/m) ??
    job.match(/^ {4}if: >-\n\s+\$\{\{([\s\S]*?)\}\}/m);
  assert.ok(condition, `${jobName} has a job-level if expression`);

  const expression = condition[1]
    .replace(/\binputs\.lint\b/g, 'lint')
    .replace(/\binputs\.[a-zA-Z_][\w]*\b/g, 'true')
    .replace(/needs\.changes\.outputs\.[a-zA-Z_][\w]*\s*(?:==|!=)\s*'true'/g, 'true')
    .replace(/always\(\)/g, 'true')
    .replace(/!cancelled\(\)/g, 'true');
  return new Function('lint', `return (${expression});`)(lint);
}

test('lint false skips validation jobs; the gate runs and default lint keeps existing selection', () => {
  const lintDefault = ansibleCi.match(
    /^      lint:\n        description: .*\n        type: boolean\n        default: (true|false)$/m,
  );
  assert.ok(lintDefault, 'lint is a boolean workflow input with a default');
  assert.equal(lintDefault[1], 'true');

  for (const jobName of ['ansible-lint', 'molecule', 'token-limits', 'renovate-annotations', 'renovate_config']) {
    assert.equal(jobRuns(jobName, false), false, `${jobName} skips when lint is false`);
    assert.equal(jobRuns(jobName, lintDefault[1] === 'true'), true, `${jobName} remains selected when lint defaults true`);
  }

  assert.equal(jobRuns('gate', false), true, 'the aggregate gate runs in changes-only mode');
  assert.equal(jobRuns('gate', lintDefault[1] === 'true'), true, 'the aggregate gate runs with default lint');
  assert.match(
    ansibleCi,
    /CI_GATE_ALLOWED_SKIPS: ansible-lint, molecule, token-limits, renovate-annotations, renovate_config/,
  );
});

test('tiny output is wired from Detect Changes and narrows Molecule only outside the full tier', () => {
  assert.match(ansibleCi, /tiny:\n\s+description: >-\n(?:.*\n)*?\s+value: \$\{\{ jobs\.changes\.outputs\.tiny \}\}/);
  assert.match(ansibleCi, /tiny: \$\{\{ steps\.tiny\.outputs\.tiny \}\}/);
  assert.match(ansibleCi, /- name: Detect tiny develop pull request\n\s+id: tiny/);
  assert.match(ansibleCi, /printf 'tiny=%s\\n' "\$tiny" >> "\$GITHUB_OUTPUT"/);
  assert.match(ansibleCi, /full_suite:\n\s+description:.*\n\s+type: boolean\n\s+default: false/);
  assert.match(
    ansibleCi,
    /needs\.changes\.outputs\.molecule == 'true' &&\n\s+\(inputs\.full_suite \|\| needs\.changes\.outputs\.tiny != 'true'\)/,
  );
});

test('tiny is false for pushes and pull requests into main', () => {
  assert.equal(runTiny({ EVENT_NAME: 'push' }), 'tiny=false');
  assert.equal(runTiny({ BASE_REF: 'main' }), 'tiny=false');
});

test('tiny is false for deleted or renamed paths', () => {
  assert.match(ansibleCi, /tiny_files:\n\s+- added\|modified: 'roles\/\*\/tasks\/\*\*'/);
  assert.match(ansibleCi, /- added\|modified: 'roles\/\*\/handlers\/\*\*'/);
  assert.equal(runTiny({ CHANGED_FILES: '1', ALLOWED_FILES: '0' }), 'tiny=false');
});

test('tiny is false when any never-tiny path changed', () => {
  const excluded = [
    '.github/**',
    'inventory/**',
    'group_vars/**',
    'host_vars/**',
    'playbooks/**',
    'tests/**',
    'molecule/**',
    'requirements*',
    'ansible.cfg',
    'roles/openbao/**',
    'roles/openbao_secrets/**',
    'roles/*/vars/**',
    '**/*secret*',
    '**/*credential*',
    '**/*token*',
    '**/vault/**',
    '*.sops.*',
    '.sops.yaml',
    'llm-models.d/**',
  ];
  for (const pattern of excluded) assert.ok(ansibleCi.includes(`              - '${pattern}'`), pattern);
  assert.equal(runTiny({ CHANGED_FILES: '1', ADDITIONS: '1', ALLOWED_FILES: '1', EXCLUDED_FILES: '1' }), 'tiny=false');
});

test('tiny is false for three files or more than ten changed lines', () => {
  assert.equal(runTiny({ CHANGED_FILES: '3', ADDITIONS: '3', ALLOWED_FILES: '3' }), 'tiny=false');
  assert.equal(runTiny({ CHANGED_FILES: '1', ADDITIONS: '11', ALLOWED_FILES: '1' }), 'tiny=false');
});

test('two task files with two changed lines produce tiny=true', () => {
  assert.match(ansibleCi, /id: classify\n[\s\S]*?list-files: json\n[\s\S]*?tiny_files:/);
  assert.equal(runTiny(), 'tiny=true');
});

test('missing or non-numeric tiny counts fail closed', () => {
  assert.equal(runTiny({ CHANGED_FILES: '' }), 'tiny=false');
  assert.equal(runTiny({ ALLOWED_FILES: 'unknown' }), 'tiny=false');
});

test('shared Ansible CI runs strict Renovate validation for renovate.json changes', () => {
  assert.match(ansibleCi, /renovate_config:\n\s+- 'renovate\.json'/);
  assert.match(ansibleCi, /renovate_config:\n\s+name: Renovate Config Validate/);
  assert.match(ansibleCi, /renovate_config_present: \$\{\{ steps\.renovate-config-file\.outputs\.present \}\}/);
  assert.match(
    ansibleCi,
    /if: \$\{\{ inputs\.lint && needs\.changes\.outputs\.renovate_config_present == 'true' && \(inputs\.full_suite \|\| needs\.changes\.outputs\.renovate_config == 'true'\) \}\}/,
  );
  assert.match(ansibleCi, /uses: \.\/\.github\/workflows\/renovate-config-validate\.yml/);
  assert.match(ansibleCi, /needs: \[changes, ansible-lint, molecule, token-limits, renovate-annotations, renovate_config\]/);
  assert.match(ansibleCi, /CI_GATE_ALLOWED_SKIPS: .*renovate_config/);
  assert.match(renovateValidator, /workflow_call:/);
  assert.match(renovateValidator, /config_file:/);
  assert.match(renovateValidator, /RENOVATE_CONFIG_FILE/);
  assert.match(renovateValidator, /renovate-config-validator --strict/);
  assert.match(renovateValidator, /RENOVATE_VERSION: "44\.82\.4"/);
  assert.match(renovateValidator, /node-version: "24\.11\.0"/);
  assert.match(renovateValidator, /key: renovate-cli-\$\{\{ runner\.os \}\}-\$\{\{ env\.RENOVATE_VERSION \}\}/);
});

test('Renovate custom managers track the validator tool and compatible Node pins', () => {
  const cases = [
    {
      depName: 'node',
      datasource: 'node-version',
      line: '          node-version: "24.11.0"',
      version: '24.11.0',
    },
    {
      depName: 'renovate',
      datasource: 'npm',
      line: '      RENOVATE_VERSION: "44.82.4"',
      version: '44.82.4',
    },
  ];

  for (const { depName, datasource, line, version } of cases) {
    const manager = renovatePreset.customManagers.find(
      (entry) => entry.depNameTemplate === depName && entry.datasourceTemplate === datasource,
    );
    assert.ok(manager, `missing ${datasource} manager for ${depName}`);
    assert.ok(manager.managerFilePatterns.some((pattern) => pattern.includes('.github/workflows')));
    const match = manager.matchStrings.map((pattern) => new RegExp(pattern).exec(line)).find(Boolean);
    assert.equal(match?.groups?.currentValue, version);
  }
});

test('unmapped Molecule paths never fail the run; they select the full profile with a warning per path', () => {
  assert.doesNotMatch(ansibleCi, /Require focused Molecule path mappings/);
  assert.doesNotMatch(ansibleCi, /Add Molecule scenario or caller-contract path mappings/);
  assert.match(ansibleCi, /echo "::notice::molecule off, mapping not required"/);
  assert.match(ansibleCi, /echo "::warning::unmapped path \$path, running full profile"/);
  assert.match(ansibleCi, /done < <\(jq -r '\.\[\]' <<<"\$\{MOLECULE_FILES:-\[\]\}"\)/);
  assert.match(ansibleCi, /echo "full_profile=true" >> "\$GITHUB_OUTPUT"/);
  assert.match(ansibleCi, /elif \[\[ "\$FULL_PROFILE" == true \]\]; then\n\s+printf 'scenarios=\\n'/);
});

test('unmapped paths warn only on molecule-matched files and select the full profile whether or not mappings are set', () => {
  assert.match(ansibleCi, /id: filter\n\s+with:\n\s+base: [^\n]*\n\s+list-files: json/);
  assert.match(ansibleCi, /MOLECULE_FILES: \$\{\{ steps\.filter\.outputs\.molecule_files \}\}/);
  assert.match(
    ansibleCi,
    /FULL_PROFILE: \$\{\{ steps\.unmapped\.outputs\.full_profile \|\| steps\.scenario_selection\.outputs\.full_profile \}\}/,
  );
  assert.doesNotMatch(ansibleCi, /still fails classification/);
});

test('Galaxy installs run only when requirements.yml exists and say so when it does not', () => {
  assert.equal((ansibleCi.match(/hashFiles\('requirements\.yml'\) != ''/g) || []).length, 4);
  assert.equal((ansibleCi.match(/echo "::notice::no requirements\.yml, nothing to install"/g) || []).length, 2);
  assert.doesNotMatch(ansibleCi, /if: steps\.galaxy-cache\.outputs\.cache-hit != 'true'\n/);
});

test('mapped Molecule paths still go through the scenario selector', () => {
  assert.match(ansibleCi, /Select scenarios only when every relevant path is covered/);
  assert.match(ansibleCi, /run: node \.gh-shared\/\.github\/scripts\/select-molecule-scenarios\.js/);
});

test('lint roles path keeps the repo ansible.cfg roles_path between repo roles/ and Galaxy roles', () => {
  const { writeFileSync } = require('node:fs');
  const step = ansibleCi.match(/- name: Set Ansible roles path\n\s+run: (.*)\n/);
  assert.ok(step, 'Set Ansible roles path step exists');
  const resolve = (cfg) => {
    const dir = mkdtempSync(join(tmpdir(), 'roles-path-'));
    if (cfg !== null) writeFileSync(join(dir, 'ansible.cfg'), cfg);
    const env = { PATH: process.env.PATH, GITHUB_WORKSPACE: '/ws', HOME: '/h', GITHUB_ENV: join(dir, 'env') };
    execFileSync('bash', ['-ec', step[1]], { cwd: dir, env });
    return readFileSync(env.GITHUB_ENV, 'utf8').trim();
  };
  assert.equal(resolve(null), 'ANSIBLE_ROLES_PATH=/ws/roles:/h/.ansible/roles');
  assert.equal(resolve('[defaults]\nroles_path = ansible/roles\n'), 'ANSIBLE_ROLES_PATH=/ws/roles:ansible/roles:/h/.ansible/roles');
  assert.equal(resolve('[defaults]\n# roles_path = nope\n'), 'ANSIBLE_ROLES_PATH=/ws/roles:/h/.ansible/roles');
});

test('the molecule output is false when the caller repo has no Molecule scenario', () => {
  assert.match(
    ansibleCi,
    /id: molecule_scenarios\n\s+if: \$\{\{ hashFiles\('\*\*\/molecule\/\*\/molecule\.yml'\) != '' \}\}\n\s+run: echo "present=true"/,
  );
  assert.match(
    ansibleCi,
    /if: \$\{\{ hashFiles\('\*\*\/molecule\/\*\/molecule\.yml'\) == '' \}\}\n\s+run: echo "::notice::no Molecule scenarios in this repository, Molecule job not applicable"/,
  );
  assert.match(
    ansibleCi,
    /molecule: >-\n\s+\$\{\{ steps\.molecule_scenarios\.outputs\.present == 'true'\n\s+&& \(inputs\.full_suite\n\s+\|\| \(steps\.filter\.outputs\.molecule == 'true'\n\s+&& steps\.nondocs\.outputs\.match == 'true'\)/,
  );
});

test('the molecule output is false when the selector maps the change to no scenario', () => {
  assert.match(
    ansibleCi,
    /&& github\.ref == 'refs\/heads\/main'\)\)\n\s+&& steps\.scenario_scope\.outputs\.scenarios != '\[\]' \}\}/,
  );
});

test('a Markdown-only change selects no lint or Molecule outside the push to main', () => {
  assert.match(
    ansibleCi,
    /id: nondocs\n\s+with:\n(?:.*\n)*?\s+predicate-quantifier: every\n\s+filters: \|\n\s+match:\n\s+- '\*\*'\n\s+- '!\*\*\/\*\.md'\n\s+- '!\*\*\/\*\.mdx'/,
  );
  assert.match(
    ansibleCi,
    /ansible: >-\n\s+\$\{\{ inputs\.full_suite\n\s+\|\| \(steps\.filter\.outputs\.ansible == 'true'\n\s+&& steps\.nondocs\.outputs\.match == 'true'\)/,
  );
});
