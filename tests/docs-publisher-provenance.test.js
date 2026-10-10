'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const run = require('../.github/scripts/docs-publisher-provenance.js');
const { isGeneratedPath, sourceLine } = run;

test('separates generated output from repository control plane', () => {
  assert.equal(isGeneratedPath('docs.json'), true);
  assert.equal(isGeneratedPath('guides/example.mdx'), true);
  assert.equal(isGeneratedPath('images/example.svg'), true);
  assert.equal(isGeneratedPath('.github/workflows/ci.yml'), false);
  assert.equal(isGeneratedPath('.claude/skills/example/SKILL.md'), false);
  assert.equal(isGeneratedPath('AGENTS.md'), false);
  assert.equal(isGeneratedPath('scripts/validate-mermaid.sh'), false);
});

test('extracts publisher source metadata without logging the body', () => {
  assert.equal(
    sourceLine('Summary\n\nDocs-Publisher-Source: 0123456789abcdef0123456789abcdef01234567\n'),
    'Docs-Publisher-Source: 0123456789abcdef0123456789abcdef01234567',
  );
  assert.equal(sourceLine('Summary only'), undefined);
});

function harness({ files, author = 'publisher[bot]', branch = 'chore/publisher/update', body = '' }) {
  const failures = [];
  const infos = [];
  return {
    failures,
    infos,
    github: {
      paginate: async () => files.map((filename) => ({ filename })),
      rest: { pulls: { listFiles: {} } },
    },
    context: {
      repo: { owner: 'example', repo: 'docs' },
      payload: {
        pull_request: {
          number: 7,
          body,
          head: { ref: branch },
          user: { login: author },
        },
      },
    },
    core: {
      info: (message) => infos.push(message),
      setFailed: (message) => failures.push(message),
    },
  };
}

test('allows control-plane changes without publisher identity', async () => {
  const state = harness({ files: ['.github/workflows/ci.yml', 'AGENTS.md'] });
  await run(state);
  assert.deepEqual(state.failures, []);
});

test('rejects generated paths without the configured publisher', async () => {
  const previousLogin = process.env.DOCS_PUBLISHER_LOGIN;
  delete process.env.DOCS_PUBLISHER_LOGIN;
  const state = harness({ files: ['docs.json'] });
  await run(state);
  assert.equal(state.failures.length, 1);
  if (previousLogin === undefined) delete process.env.DOCS_PUBLISHER_LOGIN;
  else process.env.DOCS_PUBLISHER_LOGIN = previousLogin;
});

test('accepts a pinned generated projection from the publisher', async () => {
  const previousLogin = process.env.DOCS_PUBLISHER_LOGIN;
  process.env.DOCS_PUBLISHER_LOGIN = 'publisher[bot]';
  const state = harness({
    files: ['docs.json', 'guides/example.mdx'],
    body: 'Docs-Publisher-Source: 0123456789abcdef0123456789abcdef01234567',
  });
  await run(state);
  assert.deepEqual(state.failures, []);
  if (previousLogin === undefined) delete process.env.DOCS_PUBLISHER_LOGIN;
  else process.env.DOCS_PUBLISHER_LOGIN = previousLogin;
});

test('rejects a source trailer that names a repository', async () => {
  const previousLogin = process.env.DOCS_PUBLISHER_LOGIN;
  process.env.DOCS_PUBLISHER_LOGIN = 'publisher[bot]';
  const state = harness({
    files: ['docs.json'],
    body: 'Docs-Publisher-Source: owner/source@0123456789abcdef0123456789abcdef01234567',
  });
  await run(state);
  assert.equal(state.failures.length, 1);
  if (previousLogin === undefined) delete process.env.DOCS_PUBLISHER_LOGIN;
  else process.env.DOCS_PUBLISHER_LOGIN = previousLogin;
});
