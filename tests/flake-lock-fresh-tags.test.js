'use strict';

// flake-lock-fresh.sh against local bare repositories (FLAKE_LOCK_REMOTE_BASE=file://...), so no network.
// dryvist/r: main holds c1 then c2; the annotated tag v1 was moved from c1 to c2; side holds s1, off c1.
// dryvist/shadow: the same tags, plus a branch named v1 at s1.
const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const script = path.join(__dirname, '..', 'scripts', 'flake-lock-fresh.sh');
const commits = {};
let root;
let remote;

function git(cwd, ...args) {
  const r = spawnSync(
    'git',
    ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
      '-c', 'tag.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } },
  );
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'flf-tags-'));
  const work = path.join(root, 'work');
  fs.mkdirSync(work);
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'commit', '-q', '--allow-empty', '-m', 'c1');
  commits.c1 = git(work, 'rev-parse', 'HEAD');
  git(work, 'tag', '-a', '-m', 'v1', 'v1', commits.c1);
  git(work, 'commit', '-q', '--allow-empty', '-m', 'c2');
  commits.c2 = git(work, 'rev-parse', 'HEAD');
  git(work, 'tag', '-f', '-a', '-m', 'v1', 'v1', commits.c2);
  git(work, 'checkout', '-q', '-b', 'side', commits.c1);
  git(work, 'commit', '-q', '--allow-empty', '-m', 's1');
  commits.s1 = git(work, 'rev-parse', 'HEAD');
  git(work, 'checkout', '-q', 'main');
  git(work, 'branch', 'v1', commits.s1);
  git(work, 'tag', 'v1.0.0', commits.c1);

  remote = path.join(root, 'remote');
  fs.mkdirSync(path.join(remote, 'dryvist'), { recursive: true });
  for (const name of ['r', 'shadow']) {
    const bare = path.join(remote, 'dryvist', `${name}.git`);
    git(root, 'clone', '-q', '--bare', work, bare);
    git(bare, 'config', 'uploadpack.allowFilter', 'true');
  }
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

// A lock with one root input, `name`, from dryvist/<name> at `ref` (undefined = no ref) locked at `rev`.
function lockWith(name, ref, rev) {
  const original = { type: 'github', owner: 'dryvist', repo: name, ...(ref === undefined ? {} : { ref }) };
  return {
    version: 7,
    root: 'root',
    nodes: {
      root: { inputs: { in: 'in' } },
      in: { original, locked: { type: 'github', owner: 'dryvist', repo: name, rev } },
    },
  };
}

function run(lock, policy) {
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  const lockPath = path.join(dir, 'flake.lock');
  const names = path.join(dir, 'stale-names');
  fs.writeFileSync(lockPath, JSON.stringify(lock));
  const env = {
    ...process.env,
    OWNERS: 'dryvist',
    FLAKE_LOCK_REMOTE_BASE: pathToFileURL(remote).href,
    STALE_NAMES_FILE: names,
    ...(policy ? { FLAKE_REF_POLICY: policy } : {}),
  };
  if (!policy) delete env.FLAKE_REF_POLICY;
  delete env.GIT_TOKEN;
  const r = spawnSync('bash', [script, lockPath], { env, encoding: 'utf8' });
  return { ...r, names: fs.readFileSync(names, 'utf8').split('\n').filter(Boolean) };
}

test('a vN ref resolves to the commit its annotated tag peels to', () => {
  const r = run(lockWith('r', 'v1', commits.c2));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`^in: at head ${commits.c2}$`, 'm'));
  assert.deepEqual(r.names, []);
});

test('a tag is resolved before a branch of the same name', () => {
  const atTag = run(lockWith('shadow', 'v1', commits.c2));
  assert.equal(atTag.status, 0, atTag.stdout + atTag.stderr);
  // The branch v1 points at s1; locking s1 is fresh only if the branch was consulted.
  const atBranch = run(lockWith('shadow', 'v1', commits.s1));
  assert.equal(atBranch.status, 1, atBranch.stdout + atBranch.stderr);
  assert.deepEqual(atBranch.names, ['in']);
});

test('in fail mode a dryvist input that names a branch or no ref fails and is not listed for relock', () => {
  for (const ref of ['main', undefined]) {
    const r = run(lockWith('r', ref, commits.c2), 'fail');
    assert.equal(r.status, 1, String(ref));
    assert.match(r.stdout, /dryvist input in \(dryvist\/r\) names (ref main|no ref); name a floating major tag \(vN\) or an exact release tag instead/);
    assert.deepEqual(r.names, []);
  }
});

test('in fail mode an exact release tag is a pin and passes', () => {
  const r = run(lockWith('r', 'v1.0.0', commits.c1), 'fail');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /::error::/);
  assert.deepEqual(r.names, []);
});

test('with no policy set a dryvist input that names a branch fails', () => {
  const r = run(lockWith('r', 'main', commits.c2));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /::error::dryvist input in \(dryvist\/r\) names ref main/);
});

test('in warn mode a dryvist input naming a branch is a warning and keeps the branch-head check', () => {
  const fresh = run(lockWith('r', 'main', commits.c2), 'warn');
  assert.equal(fresh.status, 0, fresh.stdout + fresh.stderr);
  assert.match(fresh.stdout, /::warning::dryvist input in \(dryvist\/r\) names ref main/);
  const stale = run(lockWith('r', 'main', commits.c1), 'warn');
  assert.equal(stale.status, 1, stale.stdout + stale.stderr);
  assert.deepEqual(stale.names, ['in']);
});

test('a floating tag that moved past the locked rev is not stale while the rev is in its history', () => {
  const r = run(lockWith('r', 'v1', commits.c1));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`^in: ${commits.c1} is in the history of v1`, 'm'));
  assert.deepEqual(r.names, []);
});

test('a locked rev outside the tag history is stale and listed for relock', () => {
  const r = run(lockWith('r', 'v1', commits.s1));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`in \\(dryvist/r v1\\) locked at ${commits.s1}, which is not in the history of v1`));
  assert.deepEqual(r.names, ['in']);
});

// --pr mode makes no network call for an input whose ref changed, so these cases need no remote.
function runPr(baseLock, headLock) {
  const dir = fs.mkdtempSync(path.join(root, 'pr-'));
  fs.writeFileSync(path.join(dir, 'base.lock'), JSON.stringify(baseLock));
  fs.writeFileSync(path.join(dir, 'flake.lock'), JSON.stringify(headLock));
  const env = { ...process.env, OWNERS: 'dryvist', FLAKE_REF_POLICY: 'fail' };
  delete env.GIT_TOKEN;
  return spawnSync('bash', [script, '--pr', path.join(dir, 'base.lock'), path.join(dir, 'flake.lock')], { env, encoding: 'utf8' });
}

test('--pr: an input moved from a branch to a floating tag is a deliberate re-pin and is not compared', () => {
  const r = runPr(lockWith('r', 'main', commits.c2), lockWith('r', 'v1', commits.c1));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^in: ref changed from main to v1; the new rev is not compared with the base rev$/m);
});

test('--pr: a base lock file that does not exist means the lock is new and passes', () => {
  const dir = fs.mkdtempSync(path.join(root, 'pr-'));
  fs.writeFileSync(path.join(dir, 'flake.lock'), JSON.stringify(lockWith('r', 'v1', commits.c2)));
  const env = { ...process.env, OWNERS: 'dryvist', FLAKE_REF_POLICY: 'fail' };
  delete env.GIT_TOKEN;
  const r = spawnSync('bash', [script, '--pr', path.join(dir, 'absent.lock'), path.join(dir, 'flake.lock')], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^in: unchanged from base$/m);
});

test('--pr: an input whose ref and rev are unchanged passes', () => {
  const r = runPr(lockWith('r', 'v1', commits.c2), lockWith('r', 'v1', commits.c2));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^in: unchanged from base$/m);
});
