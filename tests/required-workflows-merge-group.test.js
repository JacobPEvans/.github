import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const readWorkflow = (name) =>
  readFileSync(fileURLToPath(new URL(`../.github/workflows/${name}`, import.meta.url)), 'utf8');

// The required workflows must report on merge_group too, or the native merge
// queue stalls waiting for a context that never arrives. Every required
// context must run on a queue entry and end with success — a skipped job does
// not count — and a queue entry must never be cancelled by another one.
const requiredWorkflows = [
  'markdownlint.yml',
  'conventions-check.yml',
  'pr-policy.yml',
  'disclosure-gate.yml',
];

test('every required workflow triggers on pull_request and merge_group', () => {
  for (const name of requiredWorkflows) {
    const workflow = readWorkflow(name);
    assert.match(workflow, /^on:\n  pull_request:\n  merge_group:\n/m, name);
  }
});

test('required workflow concurrency cancels superseded pull requests only', () => {
  for (const name of requiredWorkflows) {
    const workflow = readWorkflow(name);
    assert.match(
      workflow,
      /^  group: [a-z-]+\$\{\{ github\.event\.pull_request\.number \|\| github\.sha \}\}$/m,
      name,
    );
    assert.match(workflow, /^  cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}$/m, name);
  }
});

test('the PR Title job runs on a queue entry and its first step exits 0', () => {
  const workflow = readWorkflow('pr-policy.yml');
  assert.match(
    workflow,
    /if: \$\{\{ github\.event_name == 'merge_group' \|\| contains\(fromJSON\('\["opened", "edited", "synchronize", "reopened"\]'\), github\.event\.action\) \}\}/,
  );
  assert.match(
    workflow,
    /EVENT_NAME: \$\{\{ github\.event_name \}\}\n {8}run: \|\n {10}set -euo pipefail\n\n {10}if \[\[ "\$EVENT_NAME" == "merge_group" \]\]; then\n {12}exit 0\n {10}fi/,
  );
});

test('the Workflow Policy job checks out the queue commit and diffs its pull request', () => {
  const workflow = readWorkflow('pr-policy.yml');
  assert.match(workflow, /^          ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}$/m);
  assert.match(workflow, /MERGE_HEAD_REF: \$\{\{ github\.event\.merge_group\.head_ref \}\}/);
  assert.match(workflow, /if \[\[ -z "\$PR" && "\$MERGE_HEAD_REF" =~ pr-\(\[0-9\]\+\)-\[0-9a-fA-F\]\+\$ \]\]; then/);
});

test('Markdown Lint diffs its queue entry shas and lints only those files', () => {
  const workflow = readWorkflow('markdownlint.yml');
  assert.match(workflow, /^          fetch-depth: \$\{\{ github\.event_name == 'merge_group' && '0' \|\| 2 \}\}$/m);
  assert.match(workflow, /if: github\.event_name != 'push'\n {8}env:\n {10}EVENT_NAME: \$\{\{ github\.event_name \}\}\n {10}BASE_SHA: \$\{\{ github\.event\.merge_group\.base_sha \}\}\n {10}HEAD_SHA: \$\{\{ github\.event\.merge_group\.head_sha \}\}/);
  assert.match(workflow, /if \[\[ "\$EVENT_NAME" == merge_group \]\]; then\n {12}range=\("\$BASE_SHA" "\$HEAD_SHA"\)/);
  assert.match(workflow, /if: github\.event_name != 'push' && steps\.changed\.outputs\.files != ''/);
  assert.doesNotMatch(workflow, /if: github\.event_name != 'pull_request'/);
});

test('the gate caller shape documents the merge queue triggers and no push', () => {
  const gate = readWorkflow('_ci-gate.yml');
  assert.match(
    gate,
    /#   on:\n#     pull_request:\n#       types: \[opened, synchronize, reopened, ready_for_review\]\n#     merge_group:\n#   # No push trigger:/,
  );
});

test('the gate has no concurrency block and its own caller never cancels a queue entry', () => {
  assert.doesNotMatch(readWorkflow('_ci-gate.yml'), /^concurrency:/m);
  const caller = readWorkflow('ci-gate.yml');
  assert.match(caller, /^  merge_group:$/m);
  assert.match(caller, /^  cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}$/m);
});

test('the gitleaks steps skip a queue entry and the denylist scan reads its base commit', () => {
  const gate = readWorkflow('_disclosure-gate.yml');
  assert.equal(gate.split("if: ${{ github.event_name != 'merge_group' }}").length - 1, 2);
  assert.match(gate, /BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.event\.merge_group\.base_sha \}\}/);
});
