import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(
  new URL('../.github/workflows/_org-index.yml', import.meta.url),
  'utf8',
);

test('the rendered index stays within the lint limits by construction', () => {
  const render = workflow.slice(
    workflow.indexOf('      - name: Read repository metadata and render indexes'),
    workflow.indexOf('      - name: Write the repository index lint config'),
  );

  assert.match(render, /def wrap\(\$width\)/, 'long descriptions must be wrapped onto continuation lines');
  assert.match(render, /wrap\(156\)/, 'wrapping must stay under the 160 column lint limit');
  assert.doesNotMatch(render, /\| Repository \| Description \| Topics \|/, 'table rows cannot be wrapped');
  assert.match(render, /groups\(\$archived; " \(archived\)"\)/, 'archived group headings must not repeat the active ones');
  assert.match(render, /printf '# %s\\n\\n<!-- org-index:start -->/, 'a new profile file must start with a top-level heading');
});

test('generated README is linted before the index pull request is opened or updated', () => {
  const lintStep = workflow.indexOf('      - name: Lint the generated repository index');
  const pullRequestStep = workflow.indexOf('      - name: Open or update the index pull request');

  assert.notEqual(lintStep, -1, 'the generated README lint step must exist');
  assert.notEqual(pullRequestStep, -1, 'the index pull request step must exist');
  assert.ok(lintStep < pullRequestStep, 'lint must run before pull request writes');

  const lintConfig = workflow.slice(lintStep, pullRequestStep);
  assert.match(lintConfig, /uses: DavidAnson\/markdownlint-cli2-action@/);
  assert.match(workflow, /cp "\$RUNNER_TEMP\/org-index\.md" org-index\.lint\.md/);
  assert.match(lintConfig, /globs: org-index\.lint\.md/);
});

test('changed indexes use a GitHub-signed GraphQL commit after resetting the branch to the default head', () => {
  const commitStep = workflow.slice(workflow.indexOf('      - name: Open or update the index pull request'));
  const noDiff = commitStep.indexOf('git diff --cached --quiet');
  const updateRef = commitStep.indexOf('gh api --method PATCH');
  const createCommit = commitStep.indexOf('createCommitOnBranch');

  assert.notEqual(noDiff, -1, 'the no-diff short-circuit must remain');
  assert.ok(noDiff < updateRef, 'unchanged indexes must exit before updating the automation branch');
  assert.ok(updateRef < createCommit, 'the automation branch must be reset before adding the signed commit');
  assert.match(commitStep, /head_oid=\$\(git rev-parse "\$DEFAULT_BRANCH"\)/);
  assert.match(commitStep, /gh api --method PATCH .*git\/refs\/\$branch_ref/);
  assert.match(commitStep, /gh api --method POST .*git\/refs/);
  assert.match(commitStep, /expectedHeadOid: \$head_oid/);
  assert.match(commitStep, /signature \{ isValid wasSignedByGitHub \}/);
  assert.match(commitStep, /GraphQL commit was not verified as GitHub-signed/);
  assert.match(commitStep, /base64 -w0 < "\$OUTPUT_PATH"/);
  assert.match(commitStep, /base64 -w0 < llms\.txt/);
  assert.match(commitStep, /message: \{ headline: "chore\(index\): regenerate org index" \}/);
  assert.doesNotMatch(commitStep, /\bgit commit\b|\bgit push\b/);
  assert.match(commitStep, /gh pr list --head "\$branch"/);
  assert.match(commitStep, /gh pr edit "\$pr" --base "\$DEFAULT_BRANCH"/);
  assert.match(commitStep, /gh pr create --base "\$DEFAULT_BRANCH" --head "\$branch"/);
});
