'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');

const workflow = readFileSync('.github/workflows/_post-merge.yml', 'utf8');

// Job bodies, keyed by job name: the jobs: section is the last top-level
// key, so every two-space key inside the slice is a job name. A sentinel
// key terminates the last job's body.
const jobsText = `${workflow.slice(workflow.indexOf('\njobs:\n'))}\n  end-of-jobs-sentinel:\n`;
const jobBodies = {};
const jobPattern = /^  ([a-z][a-z-]*):\n([\s\S]*?)(?=\n  [a-z][a-z-]*:\n)/gm;
let jobMatch;
while ((jobMatch = jobPattern.exec(jobsText)) !== null) {
  if (jobMatch[1] !== 'end-of-jobs-sentinel') {
    jobBodies[jobMatch[1]] = jobMatch[2];
  }
}

const SELF_JOBS = ['verify', 'verdicts', 'settle', 'revert', 'revert-changes'];

test('the workflow is callable only: no trigger of its own', () => {
  const triggerBlock = workflow.match(/^on:\n((?: {2}[^\n]*\n)+)/m);
  assert.ok(triggerBlock, 'on: block exists');
  assert.match(triggerBlock[1], /^ {2}workflow_call:$/m);
  assert.doesNotMatch(
    triggerBlock[1],
    /^ {2}(push|pull_request|pull_request_target|schedule|workflow_dispatch|repository_dispatch):$/m,
  );
});

test('no concurrency lock, and a cancelled run reverts nothing', () => {
  assert.doesNotMatch(workflow, /^concurrency:/m);
  assert.doesNotMatch(workflow, /always\(\)/);
  assert.equal((workflow.match(/!cancelled\(\) && needs\.verify\.result == 'success'/g) || []).length, 3);
});

test('a reverted pull request leaves the deferred set', () => {
  for (const name of ['revert', 'revert-changes']) {
    assert.match(jobBodies[name], /gh pr edit "\$pr" --remove-label checks:deferred/);
  }
});

test('green is not moved back when a later run already moved it past this commit', () => {
  assert.match(jobBodies.settle, /compare\/\$HEAD_SHA\.\.\.\$green" --jq \.status/);
  assert.match(jobBodies.settle, /green already contains \$HEAD_SHA/);
});

test('only the delayed revert job waits in the revert-delay environment', () => {
  assert.match(jobBodies.revert, /^    environment: revert-delay$/m);
  assert.match(jobBodies.revert, /needs\.settle\.outputs\.revert == 'delay'/);
  assert.match(jobBodies['revert-changes'], /needs\.settle\.outputs\.revert == 'now'/);
  assert.doesNotMatch(jobBodies['revert-changes'], /^    environment:/m);
  assert.equal((workflow.match(/^    environment:/gm) || []).length, 1, 'no other job declares an environment');
});

test('green moves forward only: no force push anywhere', () => {
  for (const forbidden of ['--force', 'force=true', '+refs/', 'git push -f', '"force": true', "'force': true"]) {
    assert.ok(!workflow.includes(forbidden), `no force-push pattern: ${forbidden}`);
  }
  const forward = jobBodies.settle.match(/- name: Fast-forward green to HEAD\n([\s\S]*?)(?=\n      - name: )/);
  assert.ok(forward, 'fast-forward step exists');
  assert.match(forward[1], /git\/refs\/heads\/green/);
  assert.match(forward[1], /-F force=false/);
});

test('the label names are checks:deferred and auto-revert', () => {
  assert.match(workflow, /index\("checks:deferred"\)/, 'the listing keeps checks:deferred pull requests');
  assert.match(jobBodies.revert, /--add-label auto-revert/);
  assert.match(jobBodies['revert-changes'], /--add-label auto-revert/);
});

test('every job written here carries timeout-minutes of 10 at most', () => {
  for (const name of SELF_JOBS) {
    const timeout = jobBodies[name].match(/^    timeout-minutes: (\d+)$/m);
    assert.ok(timeout, `job ${name} has timeout-minutes`);
    assert.ok(Number(timeout[1]) <= 10, `job ${name} timeout is at most 10 minutes`);
  }
  assert.doesNotMatch(jobBodies.gate, /^    timeout-minutes:/m, 'the called gate carries its own inner timeouts');
});

test('a red run posts to chat and dispatches post-merge-red with commit id and run URL', () => {
  const settle = jobBodies.settle;
  assert.match(settle, /- name: Post the red result to chat/);
  assert.match(settle, /- name: Dispatch the CI-fix reaction/);
  assert.match(settle, /-f event_type=post-merge-red/);
  assert.match(settle, /-f "client_payload\[commit\]=\$RED_SHA"/);
  assert.match(settle, /-f "client_payload\[run_url\]=\$RUN_URL"/);
  assert.match(settle, /uses: slackapi\/slack-github-action@[0-9a-f]{40} # v4\.0\.0/);
  assert.match(settle, /if: steps\.decide\.outputs\.revert != '' && env\.HAS_SLACK == 'true'/);
});

test('the AI Merge Gate verdict is required for every deferred pull request', () => {
  const verdicts = jobBodies.verdicts;
  assert.match(verdicts, /select\(\.name == "AI Merge Gate"\)/);
  for (const verdict of ['VERDICT: MERGE', 'VERDICT: CHANGES', 'VERDICT: DEFERRED']) {
    assert.ok(verdicts.includes(`"${verdict}"`), `handles ${verdict}`);
  }
  assert.match(verdicts, /SECONDS \+ 480/, 're-reads for at most 8 of the allowed 10 minutes');
});

test('a red deferred merge is reverted, labelled auto-revert and auto-merged', () => {
  for (const name of ['revert', 'revert-changes']) {
    const body = jobBodies[name];
    assert.match(body, /gh pr revert "\$pr"/);
    assert.match(body, /gh pr merge "\$revert_pr" --auto --squash/);
    assert.match(body, /green already contains \$RED_SHA/, 'a commit green already contains is never reverted');
  }
});

test('both secrets are optional and the App token step copies _flake-lock-fresh.yml', () => {
  const secretsBlock = workflow.match(/^    secrets:\n((?:      .*\n?)+)/m);
  assert.ok(secretsBlock, 'workflow_call secrets block exists');
  assert.match(secretsBlock[1], /^      AUTOMATION_APP_PRIVATE_KEY:$/m);
  assert.match(secretsBlock[1], /^      slack_webhook_url:$/m);
  assert.equal((secretsBlock[1].match(/required: false/g) || []).length, 2);
  assert.equal(
    (workflow.match(/actions\/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510 # v3/g) || []).length,
    4,
    'one App token step per privileged job',
  );
  assert.match(workflow, /client-id: \$\{\{ vars\.GH_ACTION_RELEASE_PLEASE_APP_ID \}\}/);
  assert.match(workflow, /private-key: \$\{\{ secrets\.AUTOMATION_APP_PRIVATE_KEY \}\}/);
});

test('the deferred run re-runs the shared gate on HEAD with the caller config', () => {
  assert.match(jobBodies.gate, /needs: \[verify\]/);
  assert.match(jobBodies.gate, /uses: \.\/\.github\/workflows\/_ci-gate\.yml/);
  assert.match(jobBodies.gate, /filters: \$\{\{ inputs\.filters \}\}/);
  assert.match(jobBodies.gate, /profile: \$\{\{ inputs\.profile \}\}/);
  assert.match(jobBodies.gate, /nix_build: \$\{\{ inputs\.nix_build \}\}/);
  assert.match(jobBodies.gate, /runner_label: \$\{\{ inputs\.runner_label \}\}/);
});

test('green is seeded at the commit before the push when it does not exist', () => {
  const seed = jobBodies.verify.match(/- name: Seed the green branch when it does not exist\n([\s\S]*?)(?=\n      - name: )/);
  assert.ok(seed, 'seed step exists');
  assert.match(seed[1], /BEFORE: \$\{\{ github\.event\.before \}\}/);
  assert.match(seed[1], /-f ref=refs\/heads\/green -f sha="\$seed"/);
});
