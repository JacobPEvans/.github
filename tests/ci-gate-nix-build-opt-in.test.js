import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflowText = readFileSync(
  new URL('../.github/workflows/_ci-gate.yml', import.meta.url),
  'utf8',
);

const workflow = JSON.parse(execFileSync(
  'python3',
  ['-c', 'import json, sys, yaml; print(json.dumps(yaml.load(sys.stdin, Loader=yaml.BaseLoader)))'],
  { input: workflowText, encoding: 'utf8' },
));

const nixBuildJob = workflowText.slice(
  workflowText.indexOf('\n  nix-build:\n'),
  workflowText.indexOf('\n  markdown-lint:\n'),
);

test('nix-build is gated on the nix_build toggle alone, not on profile nix', () => {
  const ifValue = workflow.jobs['nix-build'].if;
  assert.ok(ifValue, 'nix-build job has an if: expression');
  assert.match(ifValue, /inputs\.nix_build\b/);
  assert.doesNotMatch(ifValue, /inputs\.profile == 'nix'/);
});

test('nix_build_command is an empty-by-default string input forwarded as build-command', () => {
  const input = workflowText.slice(
    workflowText.indexOf('\n      nix_build_command:\n'),
    workflowText.indexOf('\n      nix_skip_deps_only:\n'),
  );
  assert.match(input, /type: string/);
  assert.match(input, /default: ''/);
  assert.match(nixBuildJob, /with:\n\s+build-command: \$\{\{ inputs\.nix_build_command \}\}/);
});
