import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const appinspectPath = path.join(repoRoot, '.github/workflows/splunk-appinspect.yml');
const releasePath = path.join(repoRoot, '.github/workflows/splunk-package-release.yml');
const appinspectWorkflow = readFileSync(appinspectPath, 'utf8');
const releaseWorkflow = readFileSync(releasePath, 'utf8');

function workflowStep(source, name) {
  const marker = `      - name: ${name}\n`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing workflow step: ${name}`);
  const next = source.indexOf('\n      - name:', start + marker.length);
  const block = source.slice(start, next === -1 ? source.length : next);
  const lines = block.split('\n');
  const runLine = lines.indexOf('        run: |');
  assert.notEqual(runLine, -1, `step has no literal run block: ${name}`);
  const script = [];
  for (const line of lines.slice(runLine + 1)) {
    if (line.trim() === '') {
      script.push('');
    } else if (line.startsWith('          ')) {
      script.push(line.slice(10));
    } else {
      break;
    }
  }
  return script.join('\n');
}

function runStep(script, cwd, env) {
  execFileSync('bash', ['-euo', 'pipefail', '-c', script], {
    cwd,
    env: { ...process.env, ...env },
    stdio: 'pipe',
  });
}

function outputValues(file) {
  return Object.fromEntries(
    readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function createFile(root, relativePath, contents = '') {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function packageFixture(layout) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'splunk-package-'));
  const appName = layout === 'package' ? 'Demo_App' : 'Legacy_App';
  if (layout === 'package') {
    createFile(root, 'package/default/app.conf', '[package]\nid = Demo_App\n[launcher]\nversion = 1.2.3\n');
    createFile(root, 'package/default/savedsearches.conf', '[demo]\nsearch = index=_internal\n');
    createFile(root, 'package/tests/test_fixture.txt', 'exclude');
    createFile(root, 'package/.git/config', 'exclude');
    createFile(root, 'package/.direnv/profile', 'exclude');
    createFile(root, 'package/.env', 'exclude');
    createFile(root, 'package/.env.development', 'exclude');
    createFile(root, 'package/.DS_Store', 'exclude');
    createFile(root, 'package/notes.local', 'exclude');
    createFile(root, 'package/editor.swp', 'exclude');
  } else {
    createFile(root, 'default/app.conf', '[package]\nid = Legacy_App\n');
    createFile(root, 'default/savedsearches.conf', '[legacy]\nsearch = index=_internal\n');
    createFile(root, 'tests/test_fixture.txt', 'exclude');
    createFile(root, '.git/config', 'exclude');
    createFile(root, '.github/workflows/local.yml', 'exclude');
    createFile(root, '.env', 'preserved by the root-layout packager');
  }
  return { root, appName };
}

function buildArchive(layout) {
  const fixture = packageFixture(layout);
  try {
    const detectOutput = path.join(fixture.root, 'detect-output.txt');
    const packageOutput = path.join(fixture.root, 'package-output.txt');
    runStep(workflowStep(appinspectWorkflow, 'Detect Splunk app'), fixture.root, {
      GITHUB_OUTPUT: detectOutput,
      REPOSITORY_NAME: 'repository-fallback',
    });
    const detected = outputValues(detectOutput);
    assert.equal(detected.is_app, 'true');
    assert.equal(detected.name, fixture.appName);
    assert.equal(detected.layout, layout);

    runStep(workflowStep(appinspectWorkflow, 'Package app'), fixture.root, {
      APP_NAME: detected.name,
      APP_LAYOUT: detected.layout,
      APP_VERSION: detected.version,
      GITHUB_OUTPUT: packageOutput,
    });
    return {
      ...fixture,
      archivePath: path.join(fixture.root, outputValues(packageOutput).path),
    };
  } catch (error) {
    rmSync(fixture.root, { recursive: true, force: true });
    throw error;
  }
}

test('package/default/app.conf produces an id-version archive with only the app tree', () => {
  const fixture = buildArchive('package');
  try {
    assert.equal(path.basename(fixture.archivePath), 'Demo_App-1.2.3.tar.gz');
    const names = execFileSync('tar', ['-tzf', fixture.archivePath], { encoding: 'utf8' })
      .trim()
      .split('\n');
    assert.ok(names.every((name) => name === 'Demo_App' || name.startsWith('Demo_App/')), names.join('\n'));
    assert.ok(names.includes('Demo_App/default/app.conf'));
    assert.ok(names.includes('Demo_App/default/savedsearches.conf'));
    for (const excluded of ['tests/', '.git/', '.direnv/', '.env', '.env.development', '.DS_Store', '.local', '.swp']) {
      assert.ok(!names.some((name) => name.includes(excluded)), `${excluded} was packaged`);
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('root-layout apps retain the org-required archive path and root packaging rules', () => {
  const fixture = buildArchive('root');
  try {
    assert.equal(path.basename(fixture.archivePath), 'Legacy_App-org-required.tar.gz');
    const names = execFileSync('tar', ['-tzf', fixture.archivePath], { encoding: 'utf8' })
      .trim()
      .split('\n');
    assert.ok(names.every((name) => name === 'Legacy_App' || name.startsWith('Legacy_App/')), names.join('\n'));
    assert.ok(names.includes('Legacy_App/default/app.conf'));
    assert.ok(names.includes('Legacy_App/.env'));
    for (const excluded of ['tests/', '.git/', '.github/']) {
      assert.ok(!names.some((name) => name.includes(excluded)), `${excluded} was packaged`);
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('the release reusable workflow inspects through the shared job before uploading its artifact', () => {
  assert.match(releaseWorkflow, /^  appinspect:\n    name: Build and inspect Splunk package\n    uses: \.\/\.github\/workflows\/splunk-appinspect\.yml$/m);
  assert.match(releaseWorkflow, /^    if: \$\{\{ github\.event_name == 'release' \}\}$/m);
  assert.match(releaseWorkflow, /actions\/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131 # v7/);
  assert.match(releaseWorkflow, /gh release upload "\$RELEASE_TAG"/);
  assert.match(releaseWorkflow, /^      contents: write$/m);
});
