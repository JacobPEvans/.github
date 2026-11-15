'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');

const workflow = readFileSync('.github/workflows/pr-automerge.yml', 'utf8');
const automergeJob = workflow.match(/^  automerge:\n([\s\S]*?)(?=^  hold:)/m);
const flat = (text) => text.replace(/\s+/g, ' ');

function jobCondition() {
  assert.ok(automergeJob, 'automerge job exists');
  const condition = automergeJob[1].match(/^    if: >-\n((?:      .*\n)+)/m);
  assert.ok(condition, 'automerge has a folded job-level if expression');
  return flat(condition[1]);
}

test('PR Auto-Merge runs on every arming and hold transition', () => {
  const triggers = workflow.match(/    types: \[(.*)\]/);
  assert.ok(triggers, 'the pull_request trigger lists its types');
  assert.equal(
    triggers[1],
    'opened, reopened, ready_for_review, synchronize, unlabeled, labeled',
  );
});

test('PR Auto-Merge never arms fork pull requests in any tier', () => {
  const forkGuard = 'github.event.pull_request.head.repo.full_name == github.repository';
  assert.equal(
    workflow.split(forkGuard).length - 1,
    2,
    'the fork guard gates both the automerge and the hold jobs',
  );
});

test('the merge tier is read in one step and an empty property means legacy', () => {
  const step = workflow.match(/- name: Read the merge tier property\n([\s\S]*?)(?=\n      - name: )/);
  assert.ok(step, 'the tier read step exists');
  assert.equal(workflow.split('id: tier').length - 1, 1, 'the tier is read in exactly one step');
  const body = flat(step[1]);
  assert.ok(
    body.includes('github.event.repository.custom_properties.merge_tier'),
    'the tier comes from the repository custom properties',
  );
  assert.ok(body.includes('[[ -n "$tier" ]] || tier=legacy'), 'an empty property falls back to legacy');
});

test('the standard and hot tiers arm every same-repository pull request', () => {
  const expression = jobCondition();
  assert.ok(expression.includes("github.event.repository.custom_properties.merge_tier == 'standard'"));
  assert.ok(expression.includes("github.event.repository.custom_properties.merge_tier == 'hot'"));
});

test('the legacy tier keeps the release App scope and the agent sandbox exclusion', () => {
  const expression = jobCondition();
  const legacyBranch = flat(`
    (github.event.repository.custom_properties.merge_tier == 'standard'
    || github.event.repository.custom_properties.merge_tier == 'hot'
    || (github.event.action != 'synchronize' && github.event.action != 'unlabeled'
    && github.event.pull_request.user.login == 'jacobpevans-release-please[bot]'
    && !startsWith(github.event.pull_request.head.ref, 'agent/zcode/')))`);
  assert.ok(
    expression.includes(legacyBranch.trim()),
    'the author filter and the agent/zcode exclusion gate only the legacy branch',
  );
  assert.equal(
    workflow.split("github.event.pull_request.user.login == 'jacobpevans-release-please[bot]'").length - 1,
    1,
    'no author filter applies outside the legacy branch',
  );
  assert.equal(
    workflow.split("!startsWith(github.event.pull_request.head.ref, 'agent/zcode/')").length - 1,
    1,
    'the agent/zcode exclusion applies only inside the legacy branch',
  );
});

test('the standard and hot tiers require both exact gate contexts', () => {
  assert.ok(
    workflow.includes('(["gate / Merge Gate", "AI Merge Gate"] - [.[] | select(.type == "required_status_checks")'),
    'the readiness rule requires both exact context names',
  );
  assert.ok(
    workflow.includes('test("(^|/ )Merge Gate$")'),
    'the legacy tier keeps its single Merge Gate rule',
  );
});

test('develop-to-main promotions are skipped only on the legacy tier', () => {
  const promotionGuard = flat(`
    !(steps.tier.outputs.tier == 'legacy'
    && github.event.pull_request.head.ref == 'develop' && github.event.pull_request.base.ref == 'main')`);
  const guards = flat(workflow).split(promotionGuard.trim()).length - 1;
  assert.equal(guards, 5, 'every arming step skips develop-to-main promotions on the legacy tier');
  assert.ok(!workflow.includes('base.ref == github.event.repository.default_branch'));
});

test('PR Auto-Merge arms a merge commit into main on git-flow repos and a squash elsewhere', () => {
  const step = workflow.match(/- name: Enable auto-merge\n([\s\S]*?)(?=\n      - name: )/);
  assert.ok(step, 'Enable auto-merge step exists');
  const body = flat(step[1]);
  assert.ok(body.includes(
    "(github.event.pull_request.base.ref == 'main' && github.event.repository.default_branch != 'main') && '--merge' || '--squash'",
  ));
  assert.ok(body.includes('gh pr merge "$PR" --auto "$METHOD"'));
  assert.ok(!body.includes('--auto --squash'), 'the method is never hard-coded');
});
