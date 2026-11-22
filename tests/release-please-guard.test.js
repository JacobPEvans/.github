'use strict';

// _release-please.yml skips release-please on a develop push whose head commit is a release pull request merge.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/_release-please.yml'), 'utf8');
const folded = workflow.split(/\n {2}release-please:\n {4}if: >-\n/)[1]?.split(/\n {4}env:\n/)[0] ?? '';

// Evaluates the job's real `if:` expression. GitHub expressions are close enough to JS here: `==`, `&&`, `||`, `!`,
// single-quoted strings, and a case-insensitive startsWith that returns false for null.
function runs({ event_name, ref, message, inputs = {}, repository = 'o/r', workflow_ref = '' }) {
  const expression = folded.replace(/\s+/g, ' ').trim().replace(/^\$\{\{ /, '').replace(/ \}\}$/, '')
    .replace('.head_commit.message', '.head_commit?.message')
    .replace(/inputs\.(target-owner|target-name)/g, "inputs['$1']");
  const startsWith = (s, p) => typeof s === 'string' && s.toLowerCase().startsWith(p.toLowerCase());
  const github = { event_name, ref, repository, workflow_ref, event: message === undefined ? {} : { head_commit: { message } } };
  const allInputs = { 'target-owner': '', 'target-name': '', ...inputs };
  return new Function('inputs', 'github', 'startsWith', `return (${expression});`)(allInputs, github, startsWith);
}

test('the job condition exists', () => {
  assert.notEqual(folded, '');
});

test('a develop push of a release pull request merge skips release-please', () => {
  assert.equal(runs({ event_name: 'push', ref: 'refs/heads/develop', message: 'chore(develop): release 8.41.1 (#3126)' }), false);
});

test('any other develop push still runs release-please', () => {
  assert.equal(runs({ event_name: 'push', ref: 'refs/heads/develop', message: 'feat: add an option (#3123)' }), true);
  assert.equal(runs({ event_name: 'push', ref: 'refs/heads/develop', message: 'chore(release): restore the 8.41.1 release state' }), true);
});

test('a main push runs release-please even with a release message', () => {
  assert.equal(runs({ event_name: 'push', ref: 'refs/heads/main', message: 'chore(develop): release 8.41.1 (#3126)' }), true);
});

test('a pull request run is unaffected', () => {
  assert.equal(runs({ event_name: 'pull_request', ref: 'refs/pull/9/merge' }), true);
});

test('the cross-repository target gate still rejects an unlisted target', () => {
  assert.equal(runs({ event_name: 'workflow_dispatch', ref: 'refs/heads/main', inputs: { 'target-owner': 'x', 'target-name': 'y' } }), false);
});
