'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const script = path.join(__dirname, '..', 'scripts', 'release-tag-guard.sh');

const FAKE_GH = [
  '#!/bin/sh',
  'printf "%s\\n" "$*" >> "$CALLS"',
  'case "$1 $2" in',
  '  "pr list") cat "$PR_LIST" ;;',
  '  api\\ *)',
  '    sha=${2#*/compare/}; sha=${sha%...main}',
  "    status=$(jq -r --arg sha \"$sha\" '.[$sha]' \"$STATUSES\")",
  '    [ "$status" != null ] || { echo "unexpected compare sha: $sha" >&2; exit 1; }',
  '    printf "%s\\n" "$status" ;;',
  '  *) echo "unexpected gh invocation: $*" >&2; exit 1 ;;',
  'esac',
].join('\n');

function pullRequest(number, sha) {
  return { number, mergeCommit: { oid: sha } };
}

function run(prs, statuses = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtg-'));
  const listPath = path.join(dir, 'prs.json');
  const statusesPath = path.join(dir, 'statuses.json');
  const callsPath = path.join(dir, 'calls');
  fs.writeFileSync(path.join(dir, 'gh'), FAKE_GH, { mode: 0o755 });
  fs.writeFileSync(listPath, JSON.stringify(prs));
  fs.writeFileSync(statusesPath, JSON.stringify(statuses));

  const result = spawnSync('bash', [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: dir + ':' + process.env.PATH,
      GH_TOKEN: 'test-token',
      GH_REPO: 'dryvist/example',
      PR_LIST: listPath,
      STATUSES: statusesPath,
      CALLS: callsPath,
    },
  });
  const calls = fs.existsSync(callsPath) ? fs.readFileSync(callsPath, 'utf8').trim().split('\n') : [];
  return { ...result, calls };
}

function assertResult(result, safe, decisions) {
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(result.stdout.endsWith('safe=' + safe + '\n'), result.stdout);
  for (const [number, sha, status] of decisions) {
    assert.ok(result.stdout.includes('PR #' + number + ' sha=' + sha + ' status=' + status));
  }
  assert.ok(
    result.calls[0].startsWith(
      'pr list --repo dryvist/example --state merged --label autorelease: pending --base develop --limit 1000 --json number,mergeCommit',
    ),
    result.calls[0],
  );
}

test('has no tag blocker when there are no pending release PRs', () => {
  assertResult(run([], {}), 'true', []);
});

test('allows a pending release PR whose merge commit is an ancestor of main', () => {
  assertResult(run([pullRequest(11, 'a11')], { a11: 'ahead' }), 'true', [[11, 'a11', 'ahead']]);
});

test('allows a pending release PR whose merge commit is identical to main', () => {
  assertResult(run([pullRequest(12, 'a12')], { a12: 'identical' }), 'true', [[12, 'a12', 'identical']]);
});

test('blocks a pending release PR whose merge commit is not yet on main', () => {
  assertResult(run([pullRequest(13, 'a13')], { a13: 'behind' }), 'false', [[13, 'a13', 'behind']]);
});

test('blocks a pending release PR whose merge commit diverged from main', () => {
  assertResult(run([pullRequest(14, 'a14')], { a14: 'diverged' }), 'false', [[14, 'a14', 'diverged']]);
});

test('blocks when one of two pending release PR merge commits is not on main', () => {
  assertResult(
    run([pullRequest(15, 'a15'), pullRequest(16, 'a16')], { a15: 'ahead', a16: 'diverged' }),
    'false',
    [
      [15, 'a15', 'ahead'],
      [16, 'a16', 'diverged'],
    ],
  );
});
