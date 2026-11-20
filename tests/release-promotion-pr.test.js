'use strict';

// _release.yml opens the promotion pull request when a release-please commit lands on develop.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/_release.yml'), 'utf8');
const job = workflow.split(/\n  promotion-pr:\n/)[1]?.split(/\n  [a-z-]+:\n/)[0] ?? '';

test('the promotion job exists', () => {
  assert.notEqual(job, '');
});

test('it runs only for a release-please commit pushed to develop', () => {
  assert.match(job, /github\.event_name == 'push'/);
  assert.match(job, /github\.ref == 'refs\/heads\/develop'/);
  assert.match(job, /startsWith\(github\.event\.head_commit\.message, 'chore\(develop\): release'\)/);
});

test('it calls the shared promotion workflow with the release App key and no token scopes', () => {
  assert.match(job, /uses: JacobPEvans\/\.github\/\.github\/workflows\/_promotion-pr\.yml@v1/);
  assert.match(job, /permissions: \{\}/);
  assert.match(job, /GH_ACTION_RELEASE_PLEASE_PRIVATE_KEY: \$\{\{ secrets\.GH_ACTION_RELEASE_PLEASE_PRIVATE_KEY \}\}/);
});

// Runs the promotion step with a stub gh that logs each call; `pr list` prints `listed`.
function runPromotion(listed, ahead = '3') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promotion-'));
  const log = path.join(dir, 'gh.log');
  fs.writeFileSync(path.join(dir, 'gh'), `#!/usr/bin/env bash
echo "$*" >> "${log}"
case "$1 $2" in
  "pr list") printf '%s' '${listed}';;
  "pr create") echo https://github.com/o/r/pull/9;;
  "pr merge") [[ -z "$FAIL_MERGE" ]] || { echo 'auto-merge is not allowed' >&2; exit 1; };;
  api*) echo ${ahead};;
esac
`, { mode: 0o755 });
  const promotion = fs.readFileSync(path.join(__dirname, '../.github/workflows/_promotion-pr.yml'), 'utf8');
  const script = promotion.split('        run: |\n')[1].replace(/^ {10}/gm, '');
  const run = (env = {}) => execFileSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script], {
    env: { PATH: `${dir}:${process.env.PATH}`, GH_REPO: 'o/r', ...env }, stdio: 'pipe',
  });
  return { run, calls: () => fs.readFileSync(log, 'utf8').trim().split('\n') };
}

test('a new promotion is set to auto-merge by merge commit', () => {
  const p = runPromotion('');
  p.run();
  const calls = p.calls();
  assert.match(calls.find((c) => c.startsWith('pr create')), /--label release:in-progress/);
  assert.equal(calls.at(-1), 'pr merge https://github.com/o/r/pull/9 --repo o/r --auto --merge');
});

test('an open promotion without auto-merge is armed; an armed one is left alone', () => {
  const unarmed = runPromotion('5 false');
  unarmed.run();
  assert.equal(unarmed.calls().at(-1), 'pr merge 5 --repo o/r --auto --merge');
  const armed = runPromotion('5 true');
  armed.run();
  assert.ok(!armed.calls().some((c) => c.startsWith('pr merge') || c.startsWith('pr create')));
});

test('the step fails when auto-merge cannot be set', () => {
  assert.throws(() => runPromotion('').run({ FAIL_MERGE: '1' }));
  assert.throws(() => runPromotion('5 false').run({ FAIL_MERGE: '1' }));
});

test('it never squashes', () => {
  const promotion = fs.readFileSync(path.join(__dirname, '../.github/workflows/_promotion-pr.yml'), 'utf8');
  assert.doesNotMatch(promotion, /--squash|--rebase/);
});
