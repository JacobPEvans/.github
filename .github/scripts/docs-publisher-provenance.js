'use strict';

const CONTROL_PLANE_PATHS = new Set([
  '.editorconfig',
  '.gitignore',
  'AGENTS.md',
  'CONTRIBUTING.md',
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'flake.lock',
  'flake.nix',
]);

function isGeneratedPath(path) {
  return !(
    CONTROL_PLANE_PATHS.has(path) ||
    path.startsWith('.claude/') ||
    path.startsWith('.github/') ||
    path.startsWith('scripts/')
  );
}

function sourceLine(body) {
  return body
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('Docs-Publisher-Source:'));
}

module.exports = async ({ github, context, core }) => {
  const pullRequest = context.payload.pull_request;
  if (!pullRequest) {
    core.setFailed('Docs publisher provenance requires a pull_request event.');
    return;
  }

  const files = await github.paginate(github.rest.pulls.listFiles, {
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: pullRequest.number,
    per_page: 100,
  });
  const generatedPaths = files.map((file) => file.filename).filter(isGeneratedPath);

  if (generatedPaths.length === 0) {
    core.info('No generated documentation paths changed.');
    return;
  }

  const expectedLogin = process.env.DOCS_PUBLISHER_LOGIN;
  const authorLogin = pullRequest.user?.login;
  const source = sourceLine(pullRequest.body || '');

  if (!expectedLogin) {
    core.setFailed('Documentation publisher identity variables are not configured.');
    return;
  }
  if (authorLogin !== expectedLogin) {
    core.setFailed('Generated documentation changes must be opened by the documentation publisher.');
    return;
  }
  if (!pullRequest.head.ref.startsWith('chore/publisher/')) {
    core.setFailed('Generated documentation changes must use a chore/publisher/* branch.');
    return;
  }

  // The trailer carries only the source commit; the publisher App identity
  // above names the source, so the PR body never names a private repository.
  const sourceRevision = source?.slice('Docs-Publisher-Source:'.length).trim();
  if (!/^[0-9a-f]{40}$/.test(sourceRevision || '')) {
    core.setFailed('Generated documentation changes require a pinned private-source revision.');
    return;
  }

  core.info(`Verified publisher provenance for ${generatedPaths.length} generated path(s).`);
};

module.exports.isGeneratedPath = isGeneratedPath;
module.exports.sourceLine = sourceLine;
