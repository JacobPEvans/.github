import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../scripts/ci-gate-uses-resolve.sh', import.meta.url));
const SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1';
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
  assert.match(run.stdout, new RegExp(`::notice::not checked \\(${ref.replace(/[./]/g, '\\$&')}\\)`));
  assert.doesNotMatch(run.stdout, /::error/);
});

test('pin policy: a dryvist ref pinned to a commit SHA passes in fail mode', () => {
  const run = runInCaller(`jobs:\n  a:\n    uses: dryvist/tool/action@${SHA}\n`, {}, {
    PIN_POLICY_MODE: 'fail',
  });

  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.doesNotMatch(run.stdout, /::(warning|error)/);
});

test('pin policy: a dryvist ref not pinned to a SHA is a warning and exits 0 in warn mode', () => {
  const run = runInCaller('jobs:\n  a:\n    uses: dryvist/tool/action@main\n', {}, { PIN_POLICY_MODE: 'warn' });

  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(
    run.stdout,
    /^::warning file=\.github\/workflows\/caller\.yml,line=3::dryvist\/tool\/action@main is not pinned to a 40-character commit SHA/m,
  );
  assert.match(run.stdout, /pin policy warn: 1 finding/);
});

test('pin policy: a dryvist ref not pinned to a SHA is an error and exits 1 in fail mode', () => {
  const run = runInCaller('jobs:\n  a:\n    uses: dryvist/tool/action@main\n', {}, {
    PIN_POLICY_MODE: 'fail',
  });

  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(
    run.stdout,
    /^::error file=\.github\/workflows\/caller\.yml,line=3::dryvist\/tool\/action@main is not pinned to a 40-character commit SHA/m,
  );
});

test('pin policy: with no mode set a dryvist ref not pinned to a SHA is an error and exits 1', () => {
  const run = runInCaller('jobs:\n  a:\n    uses: dryvist/tool/action@main\n');

  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /^::error file=\.github\/workflows\/caller\.yml,line=3::/m);
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
  assert.match(run.stdout, /^::warning file=\.envrc,line=1::use flake loads a remote dryvist flake/m);
});

test('pin policy: a remote dryvist flake in .envrc is an error and exits 1 in fail mode', () => {
  const run = runInCaller(clean, { '.envrc': 'use flake "git+https://github.com/dryvist/nix-tool"\n' }, {
    PIN_POLICY_MODE: 'fail',
  });

  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /^::error file=\.envrc,line=1::use flake loads a remote dryvist flake/m);
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

test('pin policy: a branch ref in a composite action file fails in fail mode', () => {
  const run = runInCaller(clean, {
    '.github/actions/local/action.yml': 'runs:\n  using: composite\n  steps:\n    - uses: dryvist/tool/action@main\n',
  });

  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /::error file=\.github\/actions\/local\/action\.yml,line=4::dryvist\/tool\/action@main is not pinned/);
});

test('pin policy: the legacy JacobPEvans owner alias is held to the same commit SHA rule', () => {
  const bad = runInCaller(`jobs:\n  a:\n    uses: JacobPEvans/.github/.github/workflows/_ci-gate.yml@main\n`);
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(bad.stdout, /::error file=\.github\/workflows\/caller\.yml,line=3::JacobPEvans\/\.github\/.* is not pinned/);

  const pinned = runInCaller(`jobs:\n  a:\n    uses: JacobPEvans/tool/action@${SHA} # v1.2.3\n`);
  assert.equal(pinned.status, 0, pinned.stdout + pinned.stderr);

  const personal = runInCaller(`jobs:\n  a:\n    uses: JacobPEvans-personal/tool/action@main\n`);
  assert.equal(personal.status, 0, personal.stdout + personal.stderr);
});

test('pin policy: flow-style and quoted uses entries in a composite action are checked, comments are not', () => {
  const flow = runInCaller(clean, {
    '.github/actions/local/action.yml': 'runs:\n  using: composite\n  steps:\n    - {uses: dryvist/tool/action@main}\n',
  });
  assert.equal(flow.status, 1, flow.stdout + flow.stderr);
  assert.match(flow.stdout, /::error file=\.github\/actions\/local\/action\.yml,line=4::dryvist\/tool\/action@main is not pinned/);

  const quoted = runInCaller(clean, {
    '.github/actions/local/action.yml': 'runs:\n  using: composite\n  steps:\n    - "uses": "dryvist/tool/action@develop"\n',
  });
  assert.equal(quoted.status, 1, quoted.stdout + quoted.stderr);

  const pinnedFlow = runInCaller(clean, {
    '.github/actions/local/action.yml': `runs:\n  using: composite\n  steps:\n    - {uses: dryvist/tool/action@${SHA}, with: {x: 1}}\n`,
  });
  assert.equal(pinnedFlow.status, 0, pinnedFlow.stdout + pinnedFlow.stderr);

  const comment = runInCaller(clean, {
    '.github/actions/local/action.yml': 'runs:\n  using: composite\n  steps:\n    # uses: dryvist/tool/action@main\n    - run: true\n',
  });
  assert.equal(comment.status, 0, comment.stdout + comment.stderr);
});

test('pin policy: the org name is matched without case', () => {
  const run = runInCaller(`jobs:\n  a:\n    uses: Dryvist/tool/action@main\n`);

  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /::error file=\.github\/workflows\/caller\.yml,line=3::Dryvist\/tool\/action@main is not pinned/);
});
