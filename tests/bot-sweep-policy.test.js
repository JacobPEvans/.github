'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const script = path.join(__dirname, '..', 'scripts', 'bot-sweep-policy.sh');
const projectionAuthor = 'app/openbao-service-broker';

function pr({ author = projectionAuthor, base = 'main', head = 'docs-projection', files = ['index.md'], additions = 10, deletions = 10 } = {}) {
  return {
    author: { login: author },
    baseRefName: base,
    headRefName: head,
    changedFiles: files.length,
    additions,
    deletions,
    files: files.map((file) => ({ path: file })),
  };
}

function run(input, repo = 'dryvist/docs') {
  return spawnSync('bash', [script], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: {
      ...process.env,
      REPO: repo,
      SMALL_DIFF_MAX_FILES: '5',
      SMALL_DIFF_MAX_LINES: '100',
      SMALL_DIFF_PROJECTION_AUTHOR: projectionAuthor,
      SMALL_DIFF_PROJECTION_REPO: 'dryvist/docs',
    },
  });
}

function assertPolicy(input, expected, repo) {
  const result = run(input, repo);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${expected}\n`);
  assert.equal(result.stdout.trim().split('\n').length, 1);
}

test('allows release-please PRs targeting develop through the remaining gates', () => {
  assertPolicy(pr({ author: 'app/jacobpevans-release-please', base: 'develop', head: 'release-please--branches--develop' }), 'proceed');
});

test('allows release-please PRs targeting main through the remaining gates', () => {
  assertPolicy(pr({ author: 'app/jacobpevans-release-please', base: 'main', head: 'release-please--branches--main' }), 'proceed');
});

test('allows Renovate PRs through the remaining gates', () => {
  assertPolicy(pr({ author: 'app/renovate' }), 'proceed');
});

test('allows a small projection PR in the configured repo', () => {
  assertPolicy(pr(), 'proceed');
});

test('allows exactly five files and 100 changed lines', () => {
  assertPolicy(pr({ files: ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'], additions: 50, deletions: 50 }), 'proceed');
});

test('skips a projection PR with more than five files', () => {
  assertPolicy(pr({ files: ['a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'f.md'] }), 'skip:too-large');
});

test('skips a projection PR with more than 100 changed lines', () => {
  assertPolicy(pr({ additions: 51, deletions: 50 }), 'skip:too-large');
});

test('skips workflow paths and secret, credential, auth, permission, and env paths', () => {
  for (const file of [
    '.github/workflows/publish.yml',
    'config/SECRETS.yml',
    'config/credentials.txt',
    'service/auth/token.json',
    'service/permissions.yml',
    'src/.env.local',
    'src/tls.pem',
  ]) {
    assertPolicy(pr({ files: [file] }), 'skip:sensitive-path');
  }
});

test('treats an incomplete changed file list as unverifiable', () => {
  assertPolicy({ ...pr(), changedFiles: 2 }, 'skip:size-unverifiable');
});

test('skips the projection author in any other repo', () => {
  assertPolicy(pr(), 'skip:author-not-allowed-here', 'dryvist/other');
});

test('returns exit 2 for invalid PR JSON', () => {
  const result = run('{not-json');
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
});
