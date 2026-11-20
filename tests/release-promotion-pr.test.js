'use strict';

// _release.yml opens the promotion pull request when a release-please commit lands on develop.

const assert = require('node:assert/strict');
const fs = require('node:fs');
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

test('the promotion workflow never enables auto-merge', () => {
  const promotion = fs.readFileSync(path.join(__dirname, '../.github/workflows/_promotion-pr.yml'), 'utf8');
  const steps = promotion.split('\njobs:\n')[1];
  assert.doesNotMatch(steps, /--auto\b|merge --auto|enablePullRequestAutoMerge/);
  assert.match(steps, /--label release:in-progress/);
});
