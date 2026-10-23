import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const workflowsDir = fileURLToPath(new URL('../.github/workflows/', import.meta.url));

test('the merge gate runs and aggregates the disclosure workflow', () => {
  const gate = readFileSync(workflowsDir + '_ci-gate.yml', 'utf8');
  const disclosureStart = gate.indexOf('\n  disclosure-gate:\n');
  const aggregateStart = gate.indexOf('\n  gate:\n');
  const disclosure = gate.slice(disclosureStart, aggregateStart);
  const aggregate = gate.slice(aggregateStart);

  assert.ok(disclosureStart >= 0, 'disclosure-gate job is missing');
  assert.ok(aggregateStart > disclosureStart, 'Merge Gate job is missing');
  assert.ok(disclosure.includes('uses: ./.github/workflows/_disclosure-gate.yml'));
  assert.ok(disclosure.includes('DISCLOSURE_DENYLIST: ${{ secrets.DISCLOSURE_DENYLIST }}'));
  assert.match(aggregate, /^    needs:.*\bdisclosure-gate\b/m);
});

test('the org gate caller forwards secrets to the shared gate', () => {
  const caller = readFileSync(workflowsDir + 'ci-gate.yml', 'utf8');
  assert.ok(caller.includes('uses: ./.github/workflows/_ci-gate.yml'));
  assert.ok(caller.includes('DISCLOSURE_DENYLIST: ${{ secrets.DISCLOSURE_DENYLIST }}'));
});

test('the static base pre-commit template includes the private identifier hook', () => {
  const template = readFileSync(
    fileURLToPath(new URL('../precommit/templates/base.yaml', import.meta.url)),
    'utf8',
  );

  assert.match(template, /id: private-identifier-staged-additions/);
  assert.match(template, /\.config\/gh-guard\/identifiers\.txt/);
});
