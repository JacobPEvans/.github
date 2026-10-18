'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const script = path.join(__dirname, '..', 'scripts', 'pr-automerge-hold.sh');

// A fake gh: `pr view` applies the --jq filter to $VIEW; every other call is logged to $LOG.
const FAKE_GH = `#!/usr/bin/env bash
if [[ "$1 $2" == "pr view" ]]; then
  while [[ $# -gt 0 && "$1" != --jq ]]; do shift; done
  printf '%s' "$VIEW" | jq -r "$2"
else
  echo "$*" >> "$LOG"
fi
`;

function hold(view) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-automerge-hold-'));
  fs.writeFileSync(path.join(dir, 'gh'), FAKE_GH, { mode: 0o755 });
  const log = path.join(dir, 'gh.log');
  fs.writeFileSync(log, '');
  execFileSync('bash', [script, 'o/r', '7'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, VIEW: JSON.stringify(view), LOG: log },
  });
  return fs.readFileSync(log, 'utf8').trim();
}

const armed = { enabledAt: '2026-10-18T00:00:00Z' };

test('turns auto-merge off on a held PR with auto-merge armed', () => {
  assert.equal(hold({ labels: [{ name: 'size/xs' }, { name: 'human:review' }], autoMergeRequest: armed }),
    'pr merge 7 --repo o/r --disable-auto');
});

test('leaves an unheld or unarmed PR alone', () => {
  assert.equal(hold({ labels: [{ name: 'size/xs' }], autoMergeRequest: armed }), '');
  assert.equal(hold({ labels: [{ name: 'human:review' }], autoMergeRequest: null }), '');
  assert.equal(hold({ labels: [], autoMergeRequest: null }), '');
});
