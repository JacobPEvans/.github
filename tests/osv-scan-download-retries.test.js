'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');

const workflow = readFileSync('.github/workflows/_osv-scan.yml', 'utf8');
const downloadStart = workflow.indexOf('      - name: Download osv-scanner\n');
const verifyStart = workflow.indexOf('      - name: Verify and install osv-scanner\n');
const scanStart = workflow.indexOf('      - name: Scan\n', verifyStart);
const downloadStep = workflow.slice(downloadStart, verifyStart);
const verifyStep = workflow.slice(verifyStart, scanStart);

test('OSV release downloads authenticate, retry transient fetches, and verify after download', () => {
  assert.ok(downloadStart >= 0, 'the download step exists');
  assert.ok(verifyStart > downloadStart, 'verification follows the retried download');
  assert.match(downloadStep, /^        uses: nick-fields\/retry@ad984534de44a9489a53aefd81eb77f87c70dc60 # v4\.0\.0$/m);
  assert.match(downloadStep, /^          GH_TOKEN: \$\{\{ github\.token \}\}$/m);
  assert.match(downloadStep, /^          max_attempts: 3$/m);
  assert.match(downloadStep, /^          retry_wait_seconds: 30$/m);
  assert.match(downloadStep, /^          timeout_minutes: 1$/m);
  assert.match(downloadStep, /gh release download "\$OSV_SCANNER_VERSION" --repo google\/osv-scanner/);
  assert.match(downloadStep, /--pattern "\$asset" --pattern osv-scanner_SHA256SUMS --dir "\$RUNNER_TEMP"/);
  assert.match(downloadStep, /if command -v gh >\/dev\/null 2>&1; then[\s\S]*?else\n\s+unset GH_TOKEN/);
  assert.equal((downloadStep.match(/curl -fsSL --retry 5 --retry-all-errors --retry-delay 10 --connect-timeout 20/g) || []).length, 2);
  assert.doesNotMatch(downloadStep, /sha256sum -c|shasum -a 256 -c/);

  assert.match(verifyStep, /grep " \$\{asset\}\\\$" osv-scanner_SHA256SUMS \| sha256sum -c -/);
  assert.match(verifyStep, /grep " \$\{asset\}\\\$" osv-scanner_SHA256SUMS \| shasum -a 256 -c -/);
  assert.match(verifyStep, /chmod \+x "\$\{asset\}"/);
  assert.match(verifyStep, /echo "OSV_BIN=\$\{RUNNER_TEMP\}\/\$\{asset\}" >> "\$\{GITHUB_ENV\}"/);
  assert.match(workflow, /timeout-minutes: \$\{\{ github\.event_name == 'pull_request' && 5 \|\| 30 \}\}/);
});
