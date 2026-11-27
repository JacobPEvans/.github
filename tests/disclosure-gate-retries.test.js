'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');

const workflow = readFileSync('.github/workflows/_disclosure-gate.yml', 'utf8');
const gitleaksAction = 'gitleaks/gitleaks-action@e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e # v3.0.0';
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const count = (s) => (workflow.match(new RegExp(escape(s), 'g')) || []).length;

test('gitleaks runs two scans, each retried once, with its redacted non-reporting configuration', () => {
  assert.equal(count(`uses: ${gitleaksAction}`), 4);
  for (const id of ['gitleaks-first', 'gitleaks-private-first']) {
    assert.match(workflow, new RegExp(`uses: ${escape(gitleaksAction)}\\n\\s+id: ${id}\\n\\s+continue-on-error: true`));
    assert.match(workflow, new RegExp(`if: \\$\\{\\{ steps\\.${id}\\.outcome == 'failure' \\}\\}\\n\\s+uses: ${escape(gitleaksAction)}`));
  }

  for (const setting of [
    'GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}',
    'GITLEAKS_LICENSE: ${{ secrets.GITLEAKS_LICENSE_KEY }}',
    'GITLEAKS_ENABLE_UPLOAD_ARTIFACT: "false"',
    'GITLEAKS_ENABLE_COMMENTS: "false"',
    'GITLEAKS_ENABLE_SUMMARY: "false"',
  ]) {
    assert.equal(count(setting), 4, setting);
  }
  assert.equal(count('GITLEAKS_CONFIG: ${{ runner.temp }}/gitleaks-base.toml'), 2);
  assert.equal(count('GITLEAKS_CONFIG: ${{ runner.temp }}/gitleaks-private.toml'), 2);
  assert.match(workflow, /timeout-minutes: \$\{\{ github\.event_name == 'pull_request' && 5 \|\| 30 \}\}/);
});

test('the public base keeps the built-in rules and disables only generic-api-key', () => {
  assert.match(workflow, /\[extend\]\n\s+useDefault = true\n\s+disabledRules = \["generic-api-key"\]\n/);
});

test('an empty private ruleset fails by name instead of falling back silently', () => {
  assert.match(workflow, /if \[ -z "\$GITLEAKS_PRIVATE_CONFIG" \]; then\n\s+echo "::error title=GITLEAKS_PRIVATE_CONFIG empty::[^\n]+"\n\s+exit 1\n\s+fi/);
});
