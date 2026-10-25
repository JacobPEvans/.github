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
