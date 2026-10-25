import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(
  new URL('../.github/workflows/_org-index.yml', import.meta.url),
  'utf8',
);

test('generated README is linted before the index pull request is opened or updated', () => {
  const lintStep = workflow.indexOf('      - name: Lint the generated repository index');
  const pullRequestStep = workflow.indexOf('      - name: Open or update the index pull request');

  assert.notEqual(lintStep, -1, 'the generated README lint step must exist');
  assert.notEqual(pullRequestStep, -1, 'the index pull request step must exist');
  assert.ok(lintStep < pullRequestStep, 'lint must run before pull request writes');

  const lintConfig = workflow.slice(lintStep, pullRequestStep);
  assert.match(lintConfig, /uses: DavidAnson\/markdownlint-cli2-action@/);
  assert.match(lintConfig, /globs: \$\{\{ inputs\.output_path \}\}/);
});
