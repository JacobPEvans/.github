const assert = require('node:assert/strict');
const { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const script = path.join(__dirname, '../scripts/ci-gate-watchdog.sh');
const cancelCall = 'api -X POST repos/example/repo/actions/runs/123/cancel\n';

// created_at as the Actions API formats it: UTC, whole seconds.
const createdAgo = (seconds) => new Date(Date.now() - seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const job = (id, name, status, ageSeconds = 0) => ({ id, name, status, created_at: createdAgo(ageSeconds) });

// Runs the watchdog against a fake gh. Each entry of `polls` is the jobs listing
// returned by one poll; the last listing repeats if the script polls past it.
// The fake gh applies the --jq filter with the real jq, and sleep is stubbed so
// polls run back to back.
function runWatchdog(t, polls) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ci-gate-watchdog-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = path.join(dir, 'calls');
  polls.forEach((jobs, i) => writeFileSync(path.join(dir, `poll-${i + 1}.json`), JSON.stringify({ jobs })));
  writeFileSync(path.join(dir, 'polls'), String(polls.length));

  const gh = path.join(dir, 'gh');
  writeFileSync(
    gh,
    `#!/bin/sh
dir=$(dirname "$0")
case "$*" in
  *"repos/example/repo/actions/runs/123/jobs?per_page=100"*)
    n=$(cat "$dir/seen" 2>/dev/null || echo 0)
    n=$((n + 1))
    echo "$n" > "$dir/seen"
    last=$(cat "$dir/polls")
    [ "$n" -le "$last" ] || n=$last
    expr=""
    prev=""
    for arg in "$@"; do
      [ "$prev" = "--jq" ] && expr="$arg"
      prev="$arg"
    done
    jq -r "$expr" "$dir/poll-$n.json"
    ;;
  *"repos/example/repo/actions/runs/123/cancel"*)
    printf '%s\\n' "$*" >> "$CALLS"
    ;;
  *)
    exit 1
    ;;
esac
`,
  );
  chmodSync(gh, 0o755);
  const sleep = path.join(dir, 'sleep');
  writeFileSync(sleep, '#!/bin/sh\nexit 0\n');
  chmodSync(sleep, 0o755);

  const run = spawnSync('bash', [script], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      CALLS: calls,
      GH_TOKEN: 'test',
      PATH: `${dir}:${process.env.PATH}`,
      QUEUE_TIMEOUT_MINUTES: '10',
      REPO: 'example/repo',
      RUN_ID: '123',
    },
  });
  return { run, cancelled: existsSync(calls) ? readFileSync(calls, 'utf8') : '' };
}

for (const status of ['queued', 'pending', 'requested']) {
  test(`a ${status} job older than the limit cancels the run`, (t) => {
    const { run, cancelled } = runWatchdog(t, [
      [job(456, 'shared-gate / Nix Validate / Validate', status, 3600)],
    ]);

    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Timeout \(10m\) reached/);
    assert.match(run.stdout, /Stuck job: shared-gate \/ Nix Validate \/ Validate \(\w+, \d+s since created\)/);
    assert.match(run.stdout, /Cancelling workflow run 123/);
    assert.equal(cancelled, cancelCall);
  });
}

test('a queued job younger than the limit that then completes does not cancel', (t) => {
  const { run, cancelled } = runWatchdog(t, [
    [job(456, 'shared-gate / Nix Validate / Validate', 'queued', 60)],
    [job(456, 'shared-gate / Nix Validate / Validate', 'completed', 90)],
  ]);

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /All sibling jobs completed/);
  assert.equal(cancelled, '');
});

test('a job that appears on a later poll is watched and cancels the run past the limit', (t) => {
  const { run, cancelled } = runWatchdog(t, [
    [job(1, 'shared-gate / Molecule (a)', 'in_progress', 120)],
    [job(1, 'shared-gate / Molecule (a)', 'completed', 120), job(2, 'shared-gate / Molecule (b)', 'queued', 3600)],
  ]);

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Stuck job: shared-gate \/ Molecule \(b\) \(queued, \d+s since created\)/);
  assert.equal(cancelled, cancelCall);
});

test('waiting (environment approval) and in_progress jobs past the limit are never cancelled', (t) => {
  const { run, cancelled } = runWatchdog(t, [
    [job(7, 'deploy', 'waiting', 3600), job(10, 'build', 'in_progress', 3600)],
    [job(7, 'deploy', 'completed', 3600), job(10, 'build', 'completed', 3600)],
  ]);

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /All sibling jobs completed/);
  assert.equal(cancelled, '');
});

test('the exempt Queue Watchdog and Merge Gate jobs are ignored', (t) => {
  const { run, cancelled } = runWatchdog(t, [
    [job(8, 'Queue Watchdog', 'in_progress'), job(9, 'Merge Gate', 'queued', 3600)],
  ]);

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /All sibling jobs completed/);
  assert.equal(cancelled, '');
});

test('exempt names match after a called-workflow prefix, and only as the whole last segment', (t) => {
  const { run, cancelled } = runWatchdog(t, [
    [
      job(8, 'nix / Queue Watchdog', 'in_progress', 3600),
      job(9, 'ansible / Merge Gate', 'pending', 3600),
      job(10, 'gate / AI Merge Gate', 'pending', 3600),
    ],
  ]);

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /gate \/ AI Merge Gate/);
  assert.notEqual(cancelled, '');
});

test('all siblings completed exits 0 without cancelling', (t) => {
  const { run, cancelled } = runWatchdog(t, [
    [job(1, 'lint', 'completed', 600), job(2, 'test', 'completed', 600)],
  ]);

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /All sibling jobs completed/);
  assert.equal(cancelled, '');
});

test('the watchdog stops watching inside its own pull_request timeout', () => {
  const workflow = readFileSync(path.join(__dirname, '../.github/workflows/_ci-gate.yml'), 'utf8');
  const job = workflow.slice(workflow.indexOf('\n  watchdog:'), workflow.indexOf('\n  uses-resolve:'));
  assert.match(job, /timeout-minutes: \$\{\{ github\.event_name == 'pull_request' && 5 \|\| 60 \}\}/);
  assert.match(job, /WATCH_MAX_MINUTES: \$\{\{ github\.event_name == 'pull_request' && 4 \|\| 55 \}\}/);
});
