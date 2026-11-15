import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(
  new URL('../.github/workflows/canary.yml', import.meta.url),
  'utf8',
);

test('the generated llms index does not trigger caller-contract stacks', () => {
  const codeFilter = workflow
    .split('            code:\n')[1]
    ?.split('\n            github_md:')[0];

  assert.ok(codeFilter, 'the Canary code filter must exist');
  assert.match(codeFilter, /^              - '!llms\.txt'$/m);
});

test('the markdown lint checks run only in the docs stack', () => {
  for (const stack of ['ansible', 'nix', 'tofu', 'python']) {
    const job = workflow.split(`\n  ${stack}:\n`)[1]?.split('\n\n')[0];

    assert.ok(job, `the ${stack} stack job must exist`);
    assert.match(job, /^      markdown_lint: false$/m, `${stack}: markdown_lint must be off`);
    assert.match(job, /^      file_size: false$/m, `${stack}: file_size must be off`);
  }

  const docs = workflow.split('\n  docs:\n')[1]?.split('\n\n')[0];
  assert.match(docs, /^      markdown_lint: true$/m);
});
