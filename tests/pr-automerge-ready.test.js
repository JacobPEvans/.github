'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const script = path.join(__dirname, '..', 'scripts', 'pr-automerge-ready.sh');

function mergeGateCount(rules) {
  return execFileSync('bash', [script], {
    input: JSON.stringify(rules),
    encoding: 'utf8',
    env: { ...process.env, PR_AUTOMERGE_SELFTEST: '1' },
  }).trim();
}

function checks(...contexts) {
  return { type: 'required_status_checks', parameters: { required_status_checks: contexts.map((context) => ({ context })) } };
}

test('counts a bare or job-prefixed Merge Gate context', () => {
  assert.equal(mergeGateCount([checks('Merge Gate')]), '1');
  assert.equal(mergeGateCount([checks('Build & deploy', 'gate / Merge Gate')]), '1');
});

test('a branch with no required Merge Gate is not ready', () => {
  assert.equal(mergeGateCount([{ type: 'commit_message_pattern', parameters: {} }]), '0');
  assert.equal(mergeGateCount([checks('PR Title', 'Merge Gate Watchdog', 'NotMerge Gate')]), '0');
  assert.equal(mergeGateCount([]), '0');
});
