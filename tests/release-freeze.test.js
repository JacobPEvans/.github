'use strict';

// _release-freeze.yml sets release-freeze on open develop PRs; a push to main clears a freeze left by a promotion.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/_release-freeze.yml'), 'utf8');
const script = workflow.split('        run: |\n')[1].replace(/^ {10}/gm, '');

// Runs the step with a stub gh: `pr list --base main` returns the promotions, `--base develop` the develop PRs,
// and `api .../statuses/<sha>` is recorded as "<sha> <state> <description>".
function runStep(env, { promotions = [], developPrs = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-'));
  const log = path.join(dir, 'statuses.log');
  fs.writeFileSync(path.join(dir, 'main.json'), JSON.stringify(promotions.map((number) => ({ number, labels: [{ name: 'release:in-progress' }] }))));
  fs.writeFileSync(path.join(dir, 'develop.json'), JSON.stringify(developPrs));
  fs.writeFileSync(path.join(dir, 'gh'), `#!/usr/bin/env bash
if [[ "$1 $2" == "pr list" ]]; then
  if [[ " $* " == *" --base main "* ]]; then jq -r "\${@: -1}" "${dir}/main.json"; else cat "${dir}/develop.json"; fi
elif [[ "$1" == api ]]; then
  sha=\${2##*/}; state=""; desc=""
  for a in "$@"; do case $a in state=*) state=\${a#state=};; description=*) desc=\${a#description=};; esac; done
  echo "$sha $state $desc" >> "${log}"
fi
`, { mode: 0o755 });
  // The flags GitHub Actions uses for a bash step.
  execFileSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script], {
    env: { PATH: `${dir}:${process.env.PATH}`, GH_REPO: 'o/r', EVENT_NAME: 'pull_request', GITHUB_REF: '', PR_ACTION: '', PR_NUMBER: '', PR_HEAD_SHA: '', PR_HEAD_REF: '', PR_BASE_REF: '', ...env },
  });
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
}

const developPrs = [
  { number: 7, headRefOid: 'aaa', headRefName: 'feat/x' },
  { number: 8, headRefOid: 'bbb', headRefName: 'release-please--branches--develop' },
];

test('a push to main clears the freeze on every open develop PR once the promotion is closed', () => {
  assert.deepEqual(runStep({ EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main' }, { developPrs }), [
    'aaa success no release in progress',
    'bbb success exempt',
  ]);
});

test('a push to main keeps the freeze while another promotion is still open', () => {
  assert.deepEqual(runStep({ EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main' }, { promotions: [12], developPrs }), [
    'aaa failure release in progress: #12',
    'bbb success exempt',
  ]);
});

test('a push to another branch does nothing', () => {
  assert.deepEqual(runStep({ EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/develop' }, { developPrs }), []);
});

test('a develop pull request event still sets only its own head', () => {
  const env = { PR_ACTION: 'synchronize', PR_NUMBER: '7', PR_HEAD_SHA: 'aaa', PR_HEAD_REF: 'feat/x', PR_BASE_REF: 'develop' };
  assert.deepEqual(runStep(env, { promotions: [12], developPrs }), ['aaa failure release in progress: #12']);
});

test('_release.yml runs the freeze job on pull requests and on a push to main', () => {
  const release = fs.readFileSync(path.join(__dirname, '../.github/workflows/_release.yml'), 'utf8');
  const job = release.split(/\n  release-freeze:\n/)[1].split(/\n  [a-z-]+:\n/)[0];
  assert.match(job, /github\.event_name == 'pull_request' \|\| \(github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'\)/);
});
