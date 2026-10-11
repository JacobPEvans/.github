'use strict';

// cancel-on-close.sh: cancel queued and in-progress runs, skip the current run,
// and treat a 404 or already-completed response as cancelled. A fake `gh` on PATH
// answers from fixtures, and the real `jq` applies the script's --jq filter, so
// the test needs no network.
const assert = require('node:assert/strict');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const script = path.join(__dirname, '..', 'scripts', 'cancel-on-close.sh');

const FAKE_GH = `#!/bin/sh
echo "$*" >> "$DIR/calls"
case "$1 $2" in
  "run list")
    [ -f "$DIR/list-fail" ] && { echo "list failed" >&2; exit 1; }
    filter=
    while [ $# -gt 0 ]; do [ "$1" = "--jq" ] && filter=$2; shift; done
    jq -r "$filter" "$DIR/list.json" ;;
  "run cancel")
    mode=$(cat "$DIR/mode-$3" 2>/dev/null || echo ok)
    case "$mode" in
      ok) exit 0 ;;
      404) echo "HTTP 404: Not Found" >&2; exit 1 ;;
      missing) echo "could not find any workflow run with ID $3" >&2; exit 1 ;;
      completed) echo "HTTP 409: Cannot cancel a workflow run that is completed." >&2; exit 1 ;;
      *) echo "HTTP 500: boom" >&2; exit 1 ;;
    esac ;;
esac
`;

function run({ runs, modes = {}, listFail = false, runId = '999' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coc-'));
  fs.writeFileSync(path.join(dir, 'gh'), FAKE_GH, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'list.json'), JSON.stringify(runs));
  for (const [id, mode] of Object.entries(modes)) fs.writeFileSync(path.join(dir, `mode-${id}`), mode);
  if (listFail) fs.writeFileSync(path.join(dir, 'list-fail'), '');
  const r = spawnSync('bash', [script, 'feature/x'], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DIR: dir, REPO: 'dryvist/r', RUN_ID: runId, GH_TOKEN: 'test' },
    encoding: 'utf8',
  });
  const callsFile = path.join(dir, 'calls');
  const calls = fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8').split('\n') : [];
  // "run cancel <id> --repo ..." -> <id>
  const cancelled = calls.filter((l) => l.startsWith('run cancel')).map((l) => l.split(' ')[2]);
  return { ...r, cancelled };
}

const run1 = (databaseId, status) => ({ databaseId, status });

test('cancels queued and in-progress runs and skips completed runs and the current run', () => {
  const r = run({
    runs: [run1(1, 'queued'), run1(2, 'in_progress'), run1(3, 'completed'), run1(999, 'in_progress')],
    runId: '999',
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.cancelled, ['1', '2']);
});

test('treats a 404, a missing run and an already-completed response as cancelled', () => {
  const r = run({
    runs: [run1(1, 'queued'), run1(2, 'in_progress'), run1(3, 'queued')],
    modes: { 1: '404', 2: 'completed', 3: 'missing' },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.cancelled, ['1', '2', '3']);
  assert.match(r.stdout, /treated as cancelled/);
});

test('fails on any other cancel error and stops before the next run', () => {
  const r = run({
    runs: [run1(1, 'queued'), run1(2, 'queued')],
    modes: { 1: '500' },
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /HTTP 500/);
  assert.deepEqual(r.cancelled, ['1']);
});

test('fails when the run list cannot be read', () => {
  const r = run({ runs: [], listFail: true });
  assert.notEqual(r.status, 0);
  assert.deepEqual(r.cancelled, []);
});

test('succeeds without cancelling anything when no run is queued or in progress', () => {
  const r = run({ runs: [run1(1, 'completed')] });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.cancelled, []);
});
