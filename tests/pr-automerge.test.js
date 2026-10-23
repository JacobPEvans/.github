'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');

const workflow = readFileSync('.github/workflows/pr-automerge.yml', 'utf8');
const automergeJob = workflow.match(/^  automerge:\n([\s\S]*?)(?=^  hold:)/m);

test('PR Auto-Merge is armed only for session-bot pull requests', () => {
  assert.ok(automergeJob, 'automerge job exists');
  const condition = automergeJob[1].match(/^    if: >-\n((?:      .*\n)+)/m);
  assert.ok(condition, 'automerge has a folded job-level if expression');

  const expression = condition[1].replace(/\s+/g, ' ');
  assert.ok(expression.includes("github.event.action != 'labeled'"));
  assert.ok(expression.includes('github.event.pull_request.head.repo.full_name == github.repository'));
  assert.ok(expression.includes("github.event.pull_request.user.login == 'jacobpevans-claude[bot]'"));
});

test('PR Auto-Merge skips develop-to-main promotions on git-flow repos', () => {
  const promotionGuard = "!(github.event.pull_request.head.ref == 'develop' && github.event.pull_request.base.ref == 'main')";
  const guards = workflow.replace(/\s+/g, ' ').split(promotionGuard).length - 1;
  assert.equal(guards, 5, 'every arming step skips develop-to-main promotions');
  assert.ok(!workflow.includes('base.ref == github.event.repository.default_branch'));
});
