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

function runPolicy(rules, commits) {
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
      BASE: 'main',
      DEFAULT_BRANCH: 'main',
      HEAD: 'feature',
      TITLE: 'feat: add the thing',
      RULES_JSON: JSON.stringify(rules),
      COMMITS_JSON: JSON.stringify(commits),
    },
  });
}

test('PR Title keeps its check name and has read access to PR commits', () => {
  assert.match(workflow, /^    name: PR Title$/m);
  assert.match(workflow, /^      pull-requests: read$/m);
  assert.match(script, /gh api --paginate "repos\/\$REPO\/pulls\/\$PR\/commits"/);
  assert.match(script, /if \[\[ "\$BASE" == "\$DEFAULT_BRANCH" && "\$HEAD" == "develop" \]\]; then\n  exit 0/);
  assert.match(script, /if \[\[ "\$TITLE" == "Merge "\* \]\]; then\n  exit 0/);
});

test('valid commit subjects pass every regex rule', () => {
  const rules = [
    {
      type: 'commit_message_pattern',
      parameters: {
        name: 'Conventional subject',
        operator: 'regex',
        pattern: '^(feat|fix): .+',
        negate: false,
      },
    },
    {
      type: 'commit_message_pattern',
      parameters: {
        name: 'No merge commits',
        operator: 'regex',
        pattern: '^Merge ',
        negate: true,
      },
    },
  ];
  const commits = [{ sha: '1111111abcdef', commit: { message: 'fix: repair the thing\n\nBody' } }];
  const result = runPolicy(rules, commits);

  assert.equal(result.status, 0, result.stderr);
});

const conventional = {
  type: 'commit_message_pattern',
  parameters: { name: 'Conventional subject', operator: 'regex', pattern: '^(feat|fix): .+', negate: false },
};

test('a merge subject in the branch fails with its short SHA and the re-cut guidance', () => {
  const commits = [
    { sha: '1111111abcdef', commit: { message: 'fix: repair the thing' } },
    { sha: 'abcdef0123456789abcdef0123456789abcdef01', commit: { message: 'Merge develop into x\n\nBody' } },
  ];
  const result = runPolicy([conventional], commits);

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /abcdef0 "Merge develop into x" breaks commit_message_pattern \(must match\)/);
  assert.doesNotMatch(result.stderr, /1111111/);
  assert.match(result.stderr, /Re-create the branch from the base and cherry-pick the changes/);
});

test('a second rule that allows merge subjects does not excuse the stricter rule', () => {
  const lenient = {
    type: 'commit_message_pattern',
    parameters: { name: 'Or merge', operator: 'regex', pattern: '^(Merge .+|(feat|fix): .+)', negate: false },
  };
  const commits = [{ sha: 'abcdef0123456789', commit: { message: 'Merge develop into x' } }];

  assert.equal(runPolicy([conventional, lenient], commits).status, 1);
});

test('no regex rules pass without requiring a commit list', () => {
  const result = runPolicy([], []);

  assert.equal(result.status, 0, result.stderr);
});

test('an unreadable commit list fails the check', () => {
  assert.notEqual(runPolicy([conventional], 'not json').status, 0);
});

test('a negated rule rejects a subject that matches it', () => {
  const noMerge = {
    type: 'commit_message_pattern',
    parameters: { name: 'No merge commits', operator: 'regex', pattern: '^Merge ', negate: true },
  };
  const commits = [{ sha: 'abcdef0123456789', commit: { message: 'Merge develop into x' } }];
  const result = runPolicy([conventional, noMerge], commits);

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /abcdef0 "Merge develop into x" breaks commit_message_pattern \(mustnot match\): \^Merge /);
});
