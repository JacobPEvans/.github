'use strict';

// scripts/promote-major-tag.sh against a real bare origin. A fake `gh` on PATH
// returns the Canary check-run state from FAKE_CHECK, mirroring the jq output.

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const SCRIPT = path.join(__dirname, '../scripts/promote-major-tag.sh');
const FAKE_GH = '#!/bin/sh\nprintf "%s" "$FAKE_CHECK"\n';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// Origin with v1.0.0 (commit A) and the floating v1 on A. Commit B carries
// v1.1.0 and is pushed; commit C carries no tag.
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-'));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
  git(root, 'init', '-q', '--bare', origin);
  git(root, 'init', '-q', work);
  git(work, 'config', 'user.name', 'test');
  git(work, 'config', 'user.email', 'test@example.invalid');
  git(work, 'config', 'tag.gpgSign', 'false');
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'commit', '-q', '--allow-empty', '-m', 'a');
  const a = git(work, 'rev-parse', 'HEAD');
  git(work, 'tag', 'v1.0.0', a);
  git(work, 'tag', 'v1', a);
  git(work, 'push', '-q', 'origin', 'HEAD', '--tags');
  git(work, 'commit', '-q', '--allow-empty', '-m', 'b');
  const b = git(work, 'rev-parse', 'HEAD');
  git(work, 'tag', 'v1.1.0', b);
  git(work, 'push', '-q', 'origin', 'HEAD', '--tags');
  git(work, 'commit', '-q', '--allow-empty', '-m', 'c');
  const c = git(work, 'rev-parse', 'HEAD');
  return { work, origin, bin, a, b, c };
}

const remoteTag = (origin, tag) =>
  git(origin, 'rev-parse', '--verify', `refs/tags/${tag}^{commit}`);

function promote({ work, bin }, sha, { check = '', flags = [] } = {}) {
  return spawnSync('bash', [SCRIPT, sha, ...flags], {
    cwd: work,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GH_TOKEN: 'test',
      GITHUB_REPOSITORY: 'dryvist/.github',
      FAKE_CHECK: check,
    },
  });
}

test('moves the floating major tag once Canary succeeded on the release commit', () => {
  const f = fixture();
  const r = promote(f, f.b, { check: 'completed success' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(remoteTag(f.origin, 'v1'), f.b);
});

test('exits 0 without moving the tag while Canary is still running', () => {
  const f = fixture();
  const r = promote(f, f.b, { check: 'in_progress ' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /::notice::Canary on .* is in_progress/);
  assert.equal(remoteTag(f.origin, 'v1'), f.a);
});

test('exits 0 without moving the tag when no Canary check-run exists yet', () => {
  const f = fixture();
  const r = promote(f, f.b, { check: '' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /::notice::No Canary check-run/);
  assert.equal(remoteTag(f.origin, 'v1'), f.a);
});

test('fails and leaves the tag alone when Canary concluded failure', () => {
  const f = fixture();
  const r = promote(f, f.b, { check: 'completed failure' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /::error::Canary on .* concluded 'failure'/);
  assert.equal(remoteTag(f.origin, 'v1'), f.a);
});

test('exits 0 without moving anything when the commit carries no release tag', () => {
  const f = fixture();
  const r = promote(f, f.c, { check: 'completed success' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /::notice::.* has no vX\.Y\.Z tag/);
  assert.equal(remoteTag(f.origin, 'v1'), f.a);
});

test('--gate-verified skips the check-run lookup', () => {
  const f = fixture();
  // The check would fail if read; the flag means the caller already verified the summary.
  const r = promote(f, f.b, { check: 'completed failure', flags: ['--gate-verified'] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(remoteTag(f.origin, 'v1'), f.b);
});

test('refuses to move the floating tag backwards', () => {
  const f = fixture();
  promote(f, f.b, { check: 'completed success' });
  const r = promote(f, f.a, { check: 'completed success' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Refusing to move it backwards/);
  assert.equal(remoteTag(f.origin, 'v1'), f.b);
});

test('--no-canary moves the floating tag without reading the Canary check-run', () => {
  const f = fixture();
  // The check would fail if read; --no-canary means consumer repos have no Canary to read.
  const r = promote(f, f.b, { check: 'completed failure', flags: ['--no-canary'] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(remoteTag(f.origin, 'v1'), f.b);
});

test('never moves the floating tag for a prerelease-only commit', () => {
  const f = fixture();
  git(f.work, 'commit', '-q', '--allow-empty', '-m', 'd');
  const d = git(f.work, 'rev-parse', 'HEAD');
  git(f.work, 'tag', 'v1.2.0-rc.1', d);
  git(f.work, 'push', '-q', 'origin', 'HEAD', '--tags');
  const r = promote(f, d, { flags: ['--no-canary'] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /::notice::.* has no vX\.Y\.Z tag/);
  assert.equal(remoteTag(f.origin, 'v1'), f.a);
});

const RELEASE = path.join(__dirname, '../scripts/promote-major-release.sh');

function release({ work, bin }, tag, mode = '') {
  return spawnSync('bash', [RELEASE, tag, mode], {
    cwd: work,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: 'test', GITHUB_REPOSITORY: 'example/repo', FAKE_CHECK: '' },
  });
}

test('promote-major-release moves the floating tag for a stable tag with --no-canary', () => {
  const f = fixture();
  const r = release(f, 'v1.1.0', '--no-canary');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(remoteTag(f.origin, 'v1'), f.b);
});

test('promote-major-release fails on a non-release tag when the Canary gate applies', () => {
  const f = fixture();
  const r = release(f, 'name-v1.1.0');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /::error::'name-v1\.1\.0' is not a release tag/);
});

test('promote-major-release skips a component-prefixed tag with --no-canary', () => {
  const f = fixture();
  const r = release(f, 'name-v1.1.0', '--no-canary');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /::notice::'name-v1\.1\.0' is not a vMAJOR\.MINOR\.PATCH release tag/);
  assert.equal(remoteTag(f.origin, 'v1'), f.a);
});

// A new commit on top of the fixture carrying `name`, pushed with its tag.
function tagged(f, name) {
  git(f.work, 'commit', '-q', '--allow-empty', '-m', name);
  const sha = git(f.work, 'rev-parse', 'HEAD');
  git(f.work, 'tag', name, sha);
  git(f.work, 'push', '-q', 'origin', 'HEAD', '--tags');
  return sha;
}

test('moves the floating tag for a stable tag with build metadata', () => {
  const f = fixture();
  const sha = tagged(f, 'v1.1.0+rev.1');
  const r = promote(f, sha, { flags: ['--no-canary'] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(remoteTag(f.origin, 'v1'), sha);
});

for (const name of ['v1.2.0+rev.1', 'v1.2.0+cli.0.4.53']) {
  test(`promote-major-release accepts ${name}`, () => {
    const f = fixture();
    const sha = tagged(f, name);
    const r = release(f, name, '--no-canary');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(remoteTag(f.origin, 'v1'), sha);
  });
}

test('never moves the floating tag for a prerelease tag with build metadata', () => {
  const f = fixture();
  const sha = tagged(f, 'v1.2.0-rc.1+build');
  const r = promote(f, sha, { flags: ['--no-canary'] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /::notice::.* has no vX\.Y\.Z tag/);
  assert.equal(remoteTag(f.origin, 'v1'), f.a);
  const rel = release(f, 'v1.2.0-rc.1+build', '--no-canary');
  assert.equal(rel.status, 0, rel.stderr);
  assert.match(rel.stdout, /::notice::.* is not a vMAJOR\.MINOR\.PATCH release tag/);
  assert.equal(remoteTag(f.origin, 'v1'), f.a);
});

for (const name of ['v1.1.0+', 'v1.1.0+a..b', 'v1.1.0+a_b', 'v1.1.0+a.']) {
  test(`promote-major-release rejects malformed build metadata ${name}`, () => {
    const f = fixture();
    const r = release(f, name, '--no-canary');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /::notice::.* is not a vMAJOR\.MINOR\.PATCH release tag/);
    assert.equal(remoteTag(f.origin, 'v1'), f.a);
    assert.equal(release(f, name).status, 1);
  });
}

test('still refuses to move the floating tag backwards for a metadata tag', () => {
  const f = fixture();
  promote(f, f.b, { check: 'completed success' });
  git(f.work, 'tag', 'v1.0.0+rev.1', f.a);
  git(f.work, 'push', '-q', 'origin', '--tags');
  const r = promote(f, f.a, { check: 'completed success' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Refusing to move it backwards/);
  assert.equal(remoteTag(f.origin, 'v1'), f.b);
});
