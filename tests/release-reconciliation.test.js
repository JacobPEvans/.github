import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const workflowsDir = fileURLToPath(new URL('../.github/workflows/', import.meta.url));
const readWorkflow = (name) => readFileSync(`${workflowsDir}${name}`, 'utf8');
const reusable = readWorkflow('_release-please.yml');
const dispatcher = readWorkflow('release-reconciliation-canary.yml');

function extractRunBlock(workflow, stepName) {
  const step = workflow.indexOf(`      - name: ${stepName}\n`);
  assert.notEqual(step, -1, `missing workflow step ${stepName}`);
  const runHeader = '        run: |\n';
  const bodyStart = workflow.indexOf(runHeader, step) + runHeader.length;
  const nextStep = workflow.indexOf('\n      - name:', bodyStart);
  const body = workflow.slice(bodyStart, nextStep === -1 ? undefined : nextStep);
  return body.split('\n').map((line) => line.startsWith('          ') ? line.slice(10) : line).join('\n');
}

test('the parent release dispatcher is main-only, manual, and bound to one static target', () => {
  const onTriggers = dispatcher.match(/^on:\n([\s\S]*?)\npermissions:/m)?.[1].trimEnd();
  assert.equal(onTriggers, '  workflow_dispatch:');
  assert.match(dispatcher, /^    if: \$\{\{ github\.ref == 'refs\/heads\/main' \}\}$/m);
  assert.match(dispatcher, /^    uses: \.\/\.github\/workflows\/_release-please\.yml$/m);
  assert.match(dispatcher, /^      target-owner: jpe-cribl$/m);
  assert.match(dispatcher, /^      target-name: \.github$/m);
  assert.doesNotMatch(dispatcher, /target-repository|target-branch/);
  assert.match(dispatcher, /^      contents: write$/m);
  assert.match(dispatcher, /^      pull-requests: write$/m);
  assert.match(
    dispatcher,
    /^      GH_ACTION_RELEASE_PLEASE_PRIVATE_KEY: \$\{\{ secrets\.GH_ACTION_RELEASE_PLEASE_PRIVATE_KEY \}\}$/m,
  );
});

test('the reusable release job admits only blank same-repository inputs or the canonical canary pair', () => {
  assert.match(reusable, /^      target-owner:\n(?:        .*\n)*?        default: ''$/m);
  assert.match(reusable, /^      target-name:\n(?:        .*\n)*?        default: ''$/m);
  assert.doesNotMatch(reusable, /^      target-repository:|^      target-branch:/m);

  const jobStart = reusable.indexOf('  release-please:\n');
  const runsOn = reusable.indexOf('\n    runs-on:', jobStart);
  const jobCondition = reusable.slice(jobStart, runsOn);
  assert.match(jobCondition, /inputs\.target-owner == '' && inputs\.target-name == ''/);
  assert.match(jobCondition, /github\.repository == 'JacobPEvans\/\.github'/);
  assert.match(
    jobCondition,
    /github\.workflow_ref == 'JacobPEvans\/\.github\/\.github\/workflows\/release-reconciliation-canary\.yml@refs\/heads\/main'/,
  );
  assert.match(jobCondition, /github\.event_name == 'workflow_dispatch'/);
  assert.match(jobCondition, /inputs\.target-owner == 'jpe-cribl'/);
  assert.match(jobCondition, /inputs\.target-name == '\.github'/);
  assert.match(
    jobCondition,
    /RELEASE_TARGET_REPOSITORY: \$\{\{ inputs\.target-owner != '' && format\('\{0\}\/\{1\}', inputs\.target-owner, inputs\.target-name\) \|\| github\.repository \}\}/,
  );
  assert.doesNotMatch(reusable, /Resolve trusted release target|id: target/);
});

test('existing same-repository flow detection keeps its original default-branch behavior', () => {
  assert.match(reusable, /^          DEFAULT_BRANCH: \$\{\{ github\.event\.repository\.default_branch \}\}$/m);
  assert.equal(
    extractRunBlock(reusable, 'Detect repository flow').trimEnd(),
    [
      'if [[ "$DEFAULT_BRANCH" == "develop" ]]; then',
      '  echo "flow=gitflow" >> "$GITHUB_OUTPUT"',
      '  echo "target_branch=develop" >> "$GITHUB_OUTPUT"',
      'else',
      '  echo "flow=trunk" >> "$GITHUB_OUTPUT"',
      '  echo "target_branch=main" >> "$GITHUB_OUTPUT"',
      'fi',
    ].join('\n'),
  );
});

test('the cross-target App token is repository-scoped without workflow writes', () => {
  assert.match(reusable, /^          owner: \$\{\{ inputs\.target-owner \}\}$/m);
  assert.match(reusable, /^          repositories: \$\{\{ inputs\.target-name \}\}$/m);
  assert.match(reusable, /^          permission-contents: write$/m);
  assert.match(reusable, /^          permission-pull-requests: write$/m);
  assert.match(
    reusable,
    /^          permission-workflows: \$\{\{ inputs\.target-owner == '' && inputs\.target-name == '' && 'write' \|\| '' \}\}$/m,
  );
});

test('Release Please and the existing merge step use the effective repository', () => {
  assert.match(reusable, /^          repo-url: \$\{\{ env\.RELEASE_TARGET_REPOSITORY \}\}$/m);
  assert.match(
    reusable,
    /^          target-branch: \$\{\{ inputs\.target-owner != '' && 'main' \|\| steps\.flow\.outputs\.target_branch \}\}$/m,
  );
  assert.match(reusable, /^          GH_REPO: \$\{\{ env\.RELEASE_TARGET_REPOSITORY \}\}$/m);
  assert.match(reusable, /GH_REPO: \$\{\{ github\.repository \}\}/);
});

test('tag, git-flow release freeze, and release outputs remain protected', () => {
  assert.match(reusable, /if: \$\{\{ steps\.flow\.outputs\.flow == 'gitflow' && github\.ref_name == 'main' \}\}/);
  assert.match(reusable, /steps\.tag-guard\.outputs\.safe != 'true'/);
  assert.match(reusable, /skip-github-pull-request: \$\{\{ steps\.flow\.outputs\.flow == 'gitflow' && github\.ref_name == 'main' \}\}/);
  assert.match(reusable, /^      release_created:\n/m);
  assert.match(reusable, /^      tag_name:\n/m);
  assert.match(reusable, /value: \$\{\{ jobs\.release-please\.outputs\.release_created \}\}/);
  assert.match(reusable, /value: \$\{\{ jobs\.release-please\.outputs\.tag_name \}\}/);
});
