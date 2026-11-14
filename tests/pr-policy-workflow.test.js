import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const workflowPath = fileURLToPath(
  new URL('../.github/workflows/pr-policy.yml', import.meta.url),
);
const workflow = readFileSync(workflowPath, 'utf8');
const runMarker = '        run: |\n';
const runStart = workflow.indexOf(runMarker, workflow.indexOf('      - name: Check the live commit message rule'));
assert.notEqual(runStart, -1, 'PR Title script exists');
const script = workflow.slice(runStart + runMarker.length)
  .split('\n')
  .map((line) => (line.startsWith('          ') ? line.slice(10) : line))
  .join('\n')
  .trimEnd();

function runPolicy(rules, commits, count = '2') {
  const ghStub = `
gh() {
  if [[ "$1" == api && "$2" == "repos/$REPO/rules/branches/main" ]]; then
    printf '%s\\n' "$RULES_JSON"
  elif [[ "$1" == api && "$2" == --paginate && "$3" == "repos/$REPO/pulls/$PR/commits" ]]; then
    printf '%s\\n' "$COMMITS_JSON"
  else
    printf 'Unexpected gh call: %s\\n' "$*" >&2
    return 1
  fi
}
`;
  return spawnSync('bash', ['-c', `${ghStub}\n${script}`], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_TOKEN: 'test-token',
      REPO: 'example/repo',
      PR: '7',
      COMMITS: count,
      BASE: 'main',
      DEFAULT_BRANCH: 'main',
      HEAD: 'feature',
      TITLE: 'feat: add the thing',
      RULES_JSON: JSON.stringify(rules),
      COMMITS_JSON: JSON.stringify(commits),
    },
  });
}

const conventional = {
  type: 'commit_message_pattern',
  parameters: { name: 'Conventional subject', operator: 'regex', pattern: '^(feat|fix): .+', negate: false },
};
const plain = { sha: '1111111abcdef', parents: [{ sha: 'a' }], commit: { message: 'fix: repair the thing\n\nBody' } };
const merge = {
  sha: 'abcdef0123456789abcdef0123456789abcdef01',
  parents: [{ sha: 'a' }, { sha: 'b' }],
  commit: { message: 'Merge develop into x\n\nBody' },
};

test('PR Title keeps its check name and has read access to PR commits', () => {
  assert.match(workflow, /^    name: PR Title$/m);
  assert.match(workflow, /^      pull-requests: read$/m);
  // The script runs under `set -u`; every variable it reads must be in the step environment.
  for (const name of ['REPO', 'PR', 'COMMITS', 'BASE', 'DEFAULT_BRANCH', 'HEAD', 'TITLE']) {
    assert.match(workflow.slice(workflow.indexOf('  pr-title:')), new RegExp(`^          ${name}: \\$\\{\\{`, 'm'), name);
  }
  assert.match(script, /gh api --paginate "repos\/\$REPO\/pulls\/\$PR\/commits"/);
  assert.match(script, /if \[\[ "\$BASE" == "\$DEFAULT_BRANCH" && "\$HEAD" == "develop" \]\]; then\n  exit 0/);
  assert.match(script, /if \[\[ "\$TITLE" == "Merge "\* \]\]; then\n  exit 0/);
});

test('a branch with single-parent commits passes', () => {
  const result = runPolicy([conventional], [plain]);

  assert.equal(result.status, 0, result.stderr);
});

test('a merge commit in the branch fails with its short SHA and the re-cut guidance', () => {
  const result = runPolicy([conventional], [plain, merge]);

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /abcdef0 Merge develop into x/);
  assert.doesNotMatch(result.stderr, /1111111/);
  assert.match(result.stderr, /Re-create the branch from the base and cherry-pick the changes/);
});

test('no commit message rule passes without reading the commit list', () => {
  const result = runPolicy([], 'not json');

  assert.equal(result.status, 0, result.stderr);
});

test('more commits than the API lists fails instead of passing unchecked', () => {
  const result = runPolicy([conventional], [plain], '251');

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /251 commits/);
});

test('an unreadable commit list fails the check', () => {
  assert.notEqual(runPolicy([conventional], 'not json').status, 0);
});
