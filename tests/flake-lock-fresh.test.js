'use strict';

// flake-lock-fresh.sh: a direct input owned by one of OWNERS must be locked at its branch head.
// A fake `git` on PATH answers ls-remote, so the test needs no network.
const assert = require('node:assert/strict');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const script = path.join(__dirname, '..', 'scripts', 'flake-lock-fresh.sh');
const HEAD = 'a'.repeat(40);
const STALE = 'b'.repeat(40);

function run(lock, { base, status = 'ahead', maxAgeDays = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flf-'));
  // Fake git: every ref resolves to HEAD.
  fs.writeFileSync(path.join(dir, 'git'), `#!/bin/sh\nprintf '%s\\t%s\\n' ${HEAD} "$3"\n`, { mode: 0o755 });
  // Fake curl: the compare API answers with `status`.
  fs.writeFileSync(path.join(dir, 'curl'), `#!/bin/sh\necho '{"status":"${status}","ahead_by":1}'\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'flake.lock'), JSON.stringify(lock));
  const args = [];
  if (base) {
    fs.writeFileSync(path.join(dir, 'base.lock'), JSON.stringify(base));
    args.push('--pr', path.join(dir, 'base.lock'));
  }
  const names = path.join(dir, 'stale-names');
  const r = spawnSync('bash', [script, ...args, path.join(dir, 'flake.lock')], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, OWNERS: 'ours other-ours', STALE_NAMES_FILE: names, MAX_AGE_DAYS: String(maxAgeDays) },
    encoding: 'utf8',
  });
  return { ...r, names: fs.readFileSync(names, 'utf8').split('\n').filter(Boolean) };
}

const node = (owner, rev, ref, lastModified) => ({
  original: { type: 'github', owner, repo: 'r', ...(ref ? { ref } : {}) },
  locked: { type: 'github', owner, repo: 'r', rev, ...(lastModified === undefined ? {} : { lastModified }) },
});

const lock = (nodes) => ({
  version: 7,
  root: 'root',
  nodes: { root: { inputs: Object.fromEntries(Object.keys(nodes).map((k) => [k, k])) }, ...nodes },
});

test('passes when every owned input is at its branch head', () => {
  const r = run(lock({ a: node('ours', HEAD, 'main'), b: node('Ours', HEAD) }));
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('fails and names the input when an owned input is stale', () => {
  const r = run(lock({ a: node('ours', HEAD, 'main'), b: node('ours', STALE, 'develop') }));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /b \(ours\/r develop\) locked at b{40}, branch head is a{40}/);
  assert.deepEqual(r.names, ['b']);
});

test('checks every owner in OWNERS, not only the first', () => {
  const r = run(lock({ c: node('Other-Ours', STALE) }));
  assert.equal(r.status, 1);
  assert.deepEqual(r.names, ['c']);
});

test('never lists a third-party input, even a stale one', () => {
  const r = run(lock({ nixpkgs: node('NixOS', STALE, 'nixos-unstable'), b: node('ours', STALE) }));
  assert.equal(r.status, 1);
  assert.deepEqual(r.names, ['b']);
});

test('fails an owned input pinned to a revision, without listing it for relock', () => {
  const pinned = node('ours', STALE);
  pinned.original.rev = STALE;
  const r = run(lock({ p: pinned }));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /owned input p \(ours\/r\) is pinned to a rev; track a ref instead/);
  assert.deepEqual(r.names, []);
});

// --pr mode: deterministic against the base lock; the fake git (every head = HEAD) is never consulted.
const OLD = 'c'.repeat(40);

test('pr: passes an unchanged lock even when the branch head moved', () => {
  const r = run(lock({ a: node('ours', OLD, 'main') }), { base: lock({ a: node('ours', OLD, 'main') }), status: 'behind' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('pr: passes a fast-forward of a locked rev', () => {
  const r = run(lock({ a: node('ours', STALE, 'main') }), { base: lock({ a: node('ours', OLD, 'main') }), status: 'ahead' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('pr: fails a locked rev that does not descend from the base rev', () => {
  for (const status of ['behind', 'diverged']) {
    const r = run(lock({ a: node('ours', STALE, 'main') }), { base: lock({ a: node('ours', OLD, 'main') }), status });
    assert.equal(r.status, 1, status);
    assert.match(r.stdout, /a \(ours\/r\) moves from c{40} to b{40}, which does not descend from it/);
  }
});

test('pr: fails an owned input pinned to a revision', () => {
  const pinned = node('ours', OLD);
  pinned.original.rev = OLD;
  const r = run(lock({ p: pinned }), { base: lock({ p: pinned }) });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /is pinned to a rev/);
});

test('pr: passes a new input with no base entry', () => {
  const r = run(lock({ a: node('ours', STALE, 'main') }), { base: lock({}), status: 'behind' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

const secondsAgo = (days) => Math.floor(Date.now() / 1000) - days * 86400;

test('age check includes old third-party root inputs when upstream has newer commits', () => {
  const r = run(lock({ nixpkgs: node('NixOS', STALE, 'nixos-unstable', secondsAgo(31)) }), { maxAgeDays: 30 });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /nixpkgs \(NixOS\/r nixos-unstable\) is 31 days old with 1 newer upstream commit/);
  assert.deepEqual(r.names, ['nixpkgs']);
});

test('age check passes a recently locked root input even when upstream has newer commits', () => {
  const r = run(lock({ nixpkgs: node('NixOS', STALE, 'nixos-unstable', secondsAgo(29)) }), { maxAgeDays: 30 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.names, []);
});

test('age check passes an old root input when upstream has no newer commits', () => {
  const r = run(lock({ nixpkgs: node('NixOS', STALE, 'nixos-unstable', secondsAgo(181)) }), { maxAgeDays: 30, status: 'behind' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /no newer commits on nixos-unstable/);
  assert.deepEqual(r.names, []);
});

test('age check flags an old root input when a diverged upstream ref has newer commits', () => {
  const r = run(lock({ nixpkgs: node('NixOS', STALE, 'nixos-unstable', secondsAgo(31)) }), { maxAgeDays: 30, status: 'diverged' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /nixpkgs \(NixOS\/r nixos-unstable\) is 31 days old with 1 newer upstream commit/);
  assert.deepEqual(r.names, ['nixpkgs']);
});
