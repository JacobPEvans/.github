'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');

const workflow = readFileSync('.github/workflows/pr-automerge.yml', 'utf8');
const automergeJob = workflow.match(/^  automerge:\n([\s\S]*?)(?=^  hold:)/m);

test('PR Auto-Merge is limited to eligible session-bot pull requests', () => {
  assert.ok(automergeJob, 'automerge job exists');
  const condition = automergeJob[1].match(/^    if: >-\n((?:      .*\n)+)/m);
  assert.ok(condition, 'automerge has a folded job-level if expression');

  const expression = condition[1].replace(/\s+/g, ' ');
  assert.ok(expression.includes("github.event.action != 'labeled'"));
  assert.ok(expression.includes('github.event.pull_request.head.repo.full_name == github.repository'));
  assert.ok(expression.includes("github.event.pull_request.user.login == 'jacobpevans-claude[bot]'"));
  assert.ok(expression.includes("!(github.event.pull_request.head.ref == 'develop' && github.event.pull_request.base.ref == 'main')"));
});
