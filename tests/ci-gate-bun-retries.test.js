'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');

const workflow = readFileSync('.github/workflows/_ci-gate.yml', 'utf8');
const bunSetup = 'oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0';
const firstStart = workflow.indexOf('      - name: Set up bun\n');
const retryStart = workflow.indexOf('      - name: Retry setup bun\n', firstStart);
const installStart = workflow.indexOf('      - name: Install bun dependencies\n', retryStart);
const firstStep = workflow.slice(firstStart, retryStart);
const retryStep = workflow.slice(retryStart, installStart);

test('Bun setup retries once after an action failure and keeps the lockfile guard', () => {
  assert.ok(firstStart >= 0 && retryStart > firstStart && installStart > retryStart);
  assert.equal((workflow.match(new RegExp(bunSetup.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 2);
  assert.match(firstStep, /if: \$\{\{ hashFiles\('bun\.lock', 'bun\.lockb'\) != '' \}\}/);
  assert.match(firstStep, /id: setup-bun-first\n\s+continue-on-error: true/);
  assert.match(retryStep, /if: \$\{\{ steps\.setup-bun-first\.outcome == 'failure' \}\}/);
  assert.match(workflow, /- name: Install bun dependencies\n\s+if: \$\{\{ hashFiles\('bun\.lock', 'bun\.lockb'\) != '' \}\}\n\s+run: bun install --frozen-lockfile/);
});
