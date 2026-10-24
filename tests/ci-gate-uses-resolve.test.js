import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../scripts/ci-gate-uses-resolve.sh', import.meta.url));
const clean = 'jobs:\n  a:\n    runs-on: ubuntu-24.04\n';

// Builds a throwaway caller repo, runs the checker inside it, and removes it.
function runInCaller(callerYaml, extraFiles = {}, env = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ci-gate-uses-'));
  try {
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(root, '.github', 'workflows', 'caller.yml'), callerYaml);
    for (const [path, body] of Object.entries(extraFiles)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), body);
    }
    return spawnSync('bash', [script], {
      cwd: root,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, ...env },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('a local reusable reference that exists passes', () => {
  const run = runInCaller(
    'jobs:\n  gate:\n    uses: ./.github/workflows/real.yml\n',
    { '.github/workflows/real.yml': 'on: workflow_call\n' },
  );

  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /all reusable workflow references resolve/);
});

test('a missing local reusable reference fails with the caller and target named', () => {
  const run = runInCaller('jobs:\n  gate:\n    uses: ./.github/workflows/missing.yml\n');

  assert.equal(run.status, 1);
  assert.match(
    run.stdout,
    /^::error file=\.github\/workflows\/caller\.yml::\.github\/workflows\/caller\.yml calls \.\/\.github\/workflows\/missing\.yml, which does not resolve/m,
  );
});

test('third-party action references are ignored', () => {
  const run = runInCaller(
    'jobs:\n  a:\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\n',
  );

  assert.equal(run.status, 0, run.stdout + run.stderr);
});

test('a dryvist ref outside the public shared repos is not checked, only noticed', () => {
  // No GH_TOKEN is set, so reaching `gh api` would fail the run. A zero exit
  // with the notice proves the reference was skipped, not looked up.
  const ref = 'dryvist/private-thing/.github/workflows/x.yml@main';
  const run = runInCaller(`jobs:\n  a:\n    uses: ${ref}\n`, {}, { PIN_POLICY_MODE: 'warn' });

  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, new RegExp(`::notice::not checked \\(${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`));
  assert.doesNotMatch(run.stdout, /::error/);
});

test('uses: refs are not pin-checked here; pr-policy owns that rule', () => {
  const run = runInCaller('jobs:\n  a:\n    uses: dryvist/tool/action@main\n', {}, {
    PIN_POLICY_MODE: 'fail',
  });

  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.doesNotMatch(run.stdout, /::(warning|error)/);
});

test('pin policy: a flake input without ?ref=v<major> is a warning in warn mode', () => {
  const run = runInCaller(clean, { 'flake.nix': '{\n  inputs.tool.url = "github:dryvist/nix-tool";\n}\n' }, {
    PIN_POLICY_MODE: 'warn',
  });

  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /^::warning file=flake\.nix,line=2::dryvist flake input has no \?ref=v<major>/m);
});

test('pin policy: legacy JacobPEvans owner and git+https dryvist flake inputs are checked too', () => {
  const run = runInCaller(clean, {
    'flake.nix': [
      '{',
      '  inputs.a.url = "github:JacobPEvans/nix-devenv";',
      '  inputs.b.url = "git+https://github.com/dryvist/nix-devenv.git?ref=develop";',
      '  inputs.c.url = "github:JacobPEvans/nix-devenv?ref=v1";',
      '}',
      '',
    ].join('\n'),
  }, { PIN_POLICY_MODE: 'warn' });

  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /^::warning file=flake\.nix,line=2::dryvist flake input has no \?ref=v<major>/m);
  assert.match(run.stdout, /^::warning file=flake\.nix,line=3::dryvist flake input has no \?ref=v<major>/m);
  assert.doesNotMatch(run.stdout, /line=4::/);
});

test('pin policy: a flake input without ?ref=v<major> is an error and exits 1 in fail mode', () => {
  const run = runInCaller(clean, { 'flake.nix': '{\n  inputs.tool.url = "github:dryvist/nix-tool";\n}\n' }, {
    PIN_POLICY_MODE: 'fail',
  });

  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /^::error file=flake\.nix,line=2::dryvist flake input has no \?ref=v<major>/m);
});

test('pin policy: a flake input with a floating major or an exact release tag passes, a branch does not', () => {
  for (const ref of ['v1', 'v1.9.10']) {
    const pinned = runInCaller(clean, { 'flake.nix': `inputs.tool.url = "github:dryvist/nix-tool?ref=${ref}";\n` }, {
      PIN_POLICY_MODE: 'fail',
    });
    assert.equal(pinned.status, 0, ref + pinned.stdout + pinned.stderr);
    assert.doesNotMatch(pinned.stdout, /::(warning|error)/);
  }

  for (const ref of ['main', 'develop', 'v1.9', 'v1.9.10-rc1']) {
    const branch = runInCaller(clean, { 'flake.nix': `inputs.tool.url = "github:dryvist/nix-tool?ref=${ref}";\n` }, {
      PIN_POLICY_MODE: 'fail',
    });
    assert.equal(branch.status, 1, ref + branch.stdout + branch.stderr);
  }
});

test('pin policy: a remote dryvist flake in .envrc is a warning in warn mode', () => {
  const run = runInCaller(clean, { '.envrc': 'use flake github:dryvist/nix-tool\n' }, { PIN_POLICY_MODE: 'warn' });

  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /^::warning file=\.envrc,line=1::use flake loads a remote dryvist or JacobPEvans flake/m);
});

test('pin policy: a remote dryvist flake in .envrc is an error and exits 1 in fail mode', () => {
  const run = runInCaller(clean, { '.envrc': 'use flake "git+https://github.com/dryvist/nix-tool"\n' }, {
    PIN_POLICY_MODE: 'fail',
  });

  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /^::error file=\.envrc,line=1::use flake loads a remote dryvist or JacobPEvans flake/m);
});

test('pin policy: a local .envrc flake passes in fail mode', () => {
  const run = runInCaller(clean, { '.envrc': 'use flake .\n' }, { PIN_POLICY_MODE: 'fail' });

  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.doesNotMatch(run.stdout, /::(warning|error)/);
});

test('pin policy: a dryvist git source on main is a warning in warn mode', () => {
  const requirements = [
    'collections:',
    '  - name: git+https://github.com/dryvist/ansible-tool.git',
    '    type: git',
    '    version: main',
    '',
  ].join('\n');
  const run = runInCaller(clean, { 'requirements.yml': requirements }, { PIN_POLICY_MODE: 'warn' });

  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(
    run.stdout,
    /^::warning file=requirements\.yml,line=4::dryvist git source pinned to branch main; pin a release version/m,
  );
});

test('pin policy: a dryvist git source on develop or HEAD is an error in fail mode', () => {
  const requirements = [
    'roles:',
    '  - src: git+https://github.com/dryvist/ansible-tool.git',
    '    scm: git',
    '    version: develop',
    '  - git+https://github.com/dryvist/other-tool.git,HEAD',
    '',
  ].join('\n');
  const run = runInCaller(clean, { 'requirements.yml': requirements }, { PIN_POLICY_MODE: 'fail' });

  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(
    run.stdout,
    /^::error file=requirements\.yml,line=4::dryvist git source pinned to branch develop/m,
  );
  assert.match(
    run.stdout,
    /^::error file=requirements\.yml,line=5::dryvist git source pinned to branch head/m,
  );
});

test('pin policy: a release version or a non-dryvist source on a branch passes in fail mode', () => {
  const requirements = [
    'collections:',
    '  - name: git+https://github.com/dryvist/ansible-tool.git',
    '    version: v1.2.0',
    '  - name: git+https://github.com/other/tool.git',
    '    version: main',
    '',
  ].join('\n');
  const run = runInCaller(clean, { 'requirements.yml': requirements }, { PIN_POLICY_MODE: 'fail' });

  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.doesNotMatch(run.stdout, /::(warning|error)/);
});

test('pin policy: an unknown PIN_POLICY_MODE is rejected with exit 2', () => {
  const run = runInCaller(clean, {}, { PIN_POLICY_MODE: 'strict' });

  assert.equal(run.status, 2, run.stdout + run.stderr);
  assert.match(run.stdout, /PIN_POLICY_MODE must be warn or fail/);
});
