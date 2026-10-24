import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const workflow = readFileSync(
  fileURLToPath(new URL('../.github/workflows/_molecule.yml', import.meta.url)),
  'utf8',
);
const inputSection = workflow.split('    inputs:\n')[1]?.split('    secrets:\n')[0] ?? '';
const inputDeclaration = (name) => {
  const start = inputSection.indexOf(`      ${name}:\n`);
  if (start < 0) return undefined;
  const bodyStart = start + `      ${name}:\n`.length;
  const rest = inputSection.slice(bodyStart);
  const nextInput = rest.search(/^      [a-z_]+:\n/m);
  return nextInput < 0 ? rest : rest.slice(0, nextInput);
};

test('the Molecule reusable declares the approved input contract with workflow-call types', () => {
  const requiredInputs = [
    'scenarios',
    'full_suite',
    'scenario_discovery',
    'scenario_discovery_script',
    'scenario_name_profile',
    'scenario_require_molecule_yml',
    'preflight_command',
    'static_checks',
    'discover_runner',
    'runner_label',
    'public_and_fork_hosted',
    'discover_timeout_minutes',
    'pull_request_discover_timeout_minutes',
    'timeout_minutes',
    'pull_request_timeout_minutes',
    'scenario_timeout_floors',
    'python_version',
    'python_install_mode',
    'requirements_files',
    'uv_cache',
    'ansible_home_mode',
    'molecule_roles_path',
    'galaxy_cache_enabled',
    'galaxy_cache_prefix',
    'galaxy_cache_restore_prefix',
    'galaxy_install_mode',
    'galaxy_install_script',
    'galaxy_force_install',
    'galaxy_retry_attempts',
    'galaxy_retry_wait_seconds',
    'galaxy_step_timeout_minutes',
    'galaxy_server_timeout_seconds',
    'galaxy_refresh_contracts_v5',
    'fail_fast',
    'max_parallel',
    'serialize_scenario',
    'docker_timeout_seconds',
    'docker_prune',
    'nix_scenarios',
    'molecule_args',
    'pre_steps_script',
    'extra_env',
    'molecule_workdir_mode',
    'molecule_scenario_arg',
    'instance_suffix',
    'isolate_ephemeral_directory',
    'doppler_enabled',
    'test_secret_env_map',
    'use_homarr_token',
  ];

  for (const name of requiredInputs) {
    const declaration = inputDeclaration(name);
    assert.ok(declaration, `missing workflow_call input ${name}`);
    assert.match(declaration, /^        type: (boolean|number|string)$/m, `${name} has a workflow-call type`);
  }

  for (const name of [
    'scenarios',
    'scenario_timeout_floors',
    'requirements_files',
    'nix_scenarios',
    'test_secret_env_map',
    'static_checks',
    'pre_steps_script',
    'extra_env',
  ]) {
    const declaration = inputDeclaration(name);
    assert.match(declaration, /^        type: string$/m, `${name} carries JSON in a string input`);
  }
  assert.match(inputSection, /^      max_parallel:\n        description:.*\n        type: number\n        required: false\n(?!        default:)/m);
});

test('Molecule uses a fixed default command and only appends optional argv', () => {
  assert.match(workflow, /molecule test -s "\$MOLECULE_SCENARIO" "\$\{molecule_args\[@\]\}"/);
  assert.doesNotMatch(inputSection, /^      (?:command|test_command|molecule_command):/m);
  assert.match(inputSection, /^      molecule_args:\n[\s\S]*?type: string/m);
});

test('scenario discovery, runner selection, matrix scheduling, and timeouts are explicit', () => {
  assert.match(workflow, /scenario_discovery == 'directories'/);
  assert.match(workflow, /scenario_discovery == 'repo_script'/);
  assert.match(workflow, /caller_supplied/);
  assert.match(workflow, /scenario_timeout_floors\)\[matrix\.scenario\]/);
  assert.match(inputDeclaration('pull_request_discover_timeout_minutes'), /type: number[\s\S]*?default: 15/);
  assert.match(inputDeclaration('pull_request_timeout_minutes'), /type: number[\s\S]*?default: 25/);
  assert.match(workflow, /github\.event_name == 'pull_request' && inputs\.pull_request_discover_timeout_minutes \|\| inputs\.discover_timeout_minutes.*pr-policy: timeout-exception/);
  assert.match(workflow, /github\.event_name == 'pull_request' && inputs\.pull_request_timeout_minutes \|\| \(inputs\.timeout_minutes.*pr-policy: timeout-exception/);
  assert.match(workflow, /public_and_fork_hosted && \(github\.event\.repository\.private == false \|\| github\.event\.pull_request\.head\.repo\.fork\)/);
  assert.match(workflow, /max-parallel: \$\{\{ inputs\.max_parallel \|\| 256 \}\}/);
  assert.match(workflow, /serialize_scenario && format\('molecule-/);
  assert.match(workflow, /cancel-in-progress: false/);
});

test('Galaxy cache, installation, and refresh controls cover caller modes', () => {
  assert.match(workflow, /ansible-galaxy-v2-/);
  assert.match(workflow, /galaxy_install_mode == 'collections_only'/);
  assert.match(workflow, /GALAXY_INSTALL_MODE: \$\{\{ inputs\.galaxy_install_mode \}\}/);
  assert.match(workflow, /python3 "\$GALAXY_INSTALL_SCRIPT"/);
  assert.match(workflow, /galaxy_refresh_contracts_v5 == 'on_cache_hit'/);
  assert.match(workflow, /galaxy_refresh_contracts_v5 == 'always'/);
  assert.match(workflow, /git\+https:\/\/github\.com\/dryvist\/homelab-contracts\.git#\/ansible\/,v5/);
  assert.match(inputDeclaration('galaxy_force_install'), /type: boolean[\s\S]*?default: false/);
  assert.match(workflow, /inputs\.galaxy_force_install/);
  assert.match(workflow, /GALAXY_FORCE_INSTALL: \$\{\{ inputs\.galaxy_force_install \}\}/);
  assert.match(workflow, /ansible-galaxy install -r requirements\.yml --force/);
});

test('optional static checks run once in discovery and pre-Molecule scripts are caller-relative', () => {
  assert.match(inputDeclaration('static_checks'), /default: ""/);
  const staticChecks = workflow.split('- name: Run caller static checks\n')[1]?.split('\n      - name: Discover scenario directories')[0] ?? '';
  assert.match(staticChecks, /if: \$\{\{ inputs\.static_checks != '' \}\}/);
  assert.match(staticChecks, /bash -euo pipefail -c "\$command"/);

  assert.match(inputDeclaration('pre_steps_script'), /default: ""/);
  const preSteps = workflow.split('- name: Run caller pre-Molecule script\n')[1]?.split('\n      - name: Expose additional non-secret Molecule environment')[0] ?? '';
  assert.match(preSteps, /PRE_STEPS_SCRIPT: \$\{\{ inputs\.pre_steps_script \}\}/);
  assert.match(preSteps, /script\.is_relative_to\(root\)/);
  assert.match(preSteps, /bash "\$PRE_STEPS_SCRIPT" "\$MOLECULE_SCENARIO"/);
});

test('extra Molecule environment accepts non-secret KEY=VALUE lines without shell evaluation', () => {
  assert.match(inputDeclaration('extra_env'), /default: ""/);
  const extraEnv = workflow.split('- name: Expose additional non-secret Molecule environment\n')[1]?.split('\n      - name: Fetch secrets from Doppler')[0] ?? '';
  assert.match(extraEnv, /EXTRA_ENV: \$\{\{ inputs\.extra_env \}\}/);
  assert.match(extraEnv, /line\.split\("=", 1\)/);
  assert.match(extraEnv, /name\.startswith\(\("GITHUB_", "RUNNER_"\)\)/);
  assert.match(extraEnv, /env_file\.write\(f"\{name\}=\{value\}\\n"\)/);
  assert.doesNotMatch(extraEnv, /eval|bash -c/);
  assert.ok(
    workflow.indexOf('- name: Expose additional non-secret Molecule environment')
      < workflow.indexOf('- name: Expose selected secrets to Molecule'),
    'mapped secrets are staged after optional non-secret environment values',
  );
});

test('Galaxy cache and Ansible search paths share the configured Ansible home', () => {
  const homeStep = workflow.split('- name: Set Ansible home\n')[1]?.split('\n      - name: Set up Python')[0] ?? '';
  assert.match(inputDeclaration('molecule_roles_path'), /type: string[\s\S]*?default: ""/);
  assert.match(homeStep, /id: ansible-home/);
  assert.match(homeStep, /shared\) ansible_home="\$HOME\/\.ansible"/);
  assert.match(homeStep, /runner_temp\) ansible_home="\$RUNNER_TEMP\/ansible-home"/);
  assert.match(homeStep, /MOLECULE_ROLES_PATH: \$\{\{ inputs\.molecule_roles_path \}\}/);
  assert.match(homeStep, /roles_path="\$ansible_home\/roles"[\s\S]*?realpath -m -- "\$workspace\/\$MOLECULE_ROLES_PATH"[\s\S]*?molecule_roles_path must stay within the caller repository/);
  assert.match(homeStep, /echo "ANSIBLE_HOME=\$ansible_home"[\s\S]*?printf 'ANSIBLE_ROLES_PATH=%s\\n' "\$roles_path"[\s\S]*?echo "ANSIBLE_COLLECTIONS_PATH=\$ansible_home\/collections"\n\s+\} >> "\$GITHUB_ENV"/);
  assert.match(homeStep, /echo "ansible_home=\$ansible_home" >> "\$GITHUB_OUTPUT"/);

  const cacheStep = workflow.split('- name: Cache Ansible Galaxy content\n')[1]?.split('\n      - name: Install Ansible Galaxy requirements')[0] ?? '';
  assert.match(cacheStep, /\$\{\{ steps\.ansible-home\.outputs\.ansible_home \}\}\/collections/);
  assert.match(cacheStep, /\$\{\{ steps\.ansible-home\.outputs\.ansible_home \}\}\/roles/);
  assert.doesNotMatch(cacheStep, /\$\{\{\s*env\.ANSIBLE_HOME/);
});

test('Doppler output stays out of the job environment and only configured keys are mapped', () => {
  assert.match(workflow, /DOPPLER_TOKEN:\n[\s\S]*?required: false/);
  assert.match(workflow, /HOMARR_GITHUB_TOKEN:\n[\s\S]*?required: false/);
  assert.match(workflow, /doppler-token: \$\{\{ secrets\.DOPPLER_TOKEN \}\}/);
  assert.match(workflow, /DOPPLER_OUTPUTS: \$\{\{ inputs\.doppler_enabled && toJSON\(steps\.doppler\.outputs\)/);
  assert.match(workflow, /TEST_SECRET_ENV_MAP/);
  assert.match(workflow, /GITHUB_ENV/);
  const secretStaging = workflow.indexOf('- name: Expose selected secrets to Molecule');
  assert.ok(secretStaging > 0);
  const stagedSection = workflow.slice(secretStaging);
  const moleculeStep = stagedSection.indexOf('\n      - name: Run Molecule tests');
  assert.ok(moleculeStep > 0);
  const afterMolecule = stagedSection.slice(moleculeStep + '\n      - name: Run Molecule tests'.length);
  assert.doesNotMatch(afterMolecule, /^\s+- name:/m);
  assert.doesNotMatch(workflow, /inject-env-vars:/);
});

test('all third-party actions are pinned by SHA with a version comment', () => {
  const uses = [...workflow.matchAll(/^\s*uses:\s+(.+)$/gm)].map((match) => match[1]);
  assert.ok(uses.length > 0);
  for (const use of uses) {
    assert.match(use, /^[^@]+@[0-9a-f]{40}\s+#\s+\S+$/, `action is not SHA-pinned with a version comment: ${use}`);
  }
});
