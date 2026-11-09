'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');

const workflow = readFileSync('.github/workflows/_disclosure-gate.yml', 'utf8');
const gitleaksAction = 'gitleaks/gitleaks-action@e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e # v3.0.0';

test('gitleaks retries once after failure and retains its redacted non-reporting configuration', () => {
  assert.equal((workflow.match(/uses: gitleaks\/gitleaks-action@e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e # v3\.0\.0/g) || []).length, 2);
  assert.match(workflow, new RegExp(`uses: ${gitleaksAction.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n\\s+id: gitleaks-first\\n\\s+continue-on-error: true`));
  assert.match(workflow, /if: \$\{\{ steps\.gitleaks-first\.outcome == 'failure' \}\}\n\s+uses: gitleaks\/gitleaks-action@e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e # v3\.0\.0/);

  for (const setting of [
    'GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}',
    'GITLEAKS_LICENSE: ${{ secrets.GITLEAKS_LICENSE_KEY }}',
    'GITLEAKS_CONFIG: ${{ runner.temp }}/gitleaks.toml',
    'GITLEAKS_ENABLE_UPLOAD_ARTIFACT: "false"',
    'GITLEAKS_ENABLE_COMMENTS: "false"',
    'GITLEAKS_ENABLE_SUMMARY: "false"',
  ]) {
    assert.equal((workflow.match(new RegExp(setting.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 2, setting);
  }
  assert.match(workflow, /timeout-minutes: \$\{\{ github\.event_name == 'pull_request' && 5 \|\| 30 \}\}/);
});
