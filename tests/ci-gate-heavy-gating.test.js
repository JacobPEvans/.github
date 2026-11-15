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

// The one shared condition every heavy job ANDs onto its pre-existing if.
// A fast lane (heavy_jobs false) skips them. A hot repository skips them on a
// pull request unless it carries the preflight label, and runs them on every
// other event (the merge queue, the post-merge run, the nightly suite). Outside
// the legacy tier, a release App pull request and a promotion into main on a
// git-flow repository skip them. The author and the base branch decide that,
// never a branch name or a title alone.
const SHARED_CONDITION = "(needs.lane.outputs.heavy_jobs != 'false' && (needs.lane.outputs.tier != 'hot' || github.event_name != 'pull_request' || contains(github.event.pull_request.labels.*.name, 'preflight')) && (needs.lane.outputs.tier == 'legacy' || (github.event.pull_request.user.login != 'jacobpevans-release-please[bot]' && !(startsWith(github.head_ref, 'promote/') && github.base_ref == 'main' && github.event.repository.default_branch != 'main'))))";

const HEAVY_JOBS = ['nix-build', 'python-ci', 'ansible-ci', 'tofu-ci'];

const FAST_JOBS = [
  'markdown-lint',
  'file-size',
  'token-limits',
  'python-security',
  'zizmor',
  'osv-scan',
  'dependency-review',
  'uses-resolve',
  'workflow-lint',
];

// Minimal evaluator for the GitHub Actions expression subset the heavy-job
// ifs use: literals, parentheses, !, ==, !=, &&, ||, dotted paths (including
// the .* array filter) and the startsWith, contains and cancelled functions.
// startsWith and contains are case-insensitive, like GitHub's.
function evaluate(expression, context) {
  const src = expression;
  let pos = 0;

  const asString = (value) => (value == null ? '' : String(value));
  const callFunction = (name, args) => {
    if (name === 'cancelled') return context.cancelled === true;
    if (name === 'startsWith') return asString(args[0]).toLowerCase().startsWith(asString(args[1]).toLowerCase());
    if (name === 'contains') {
      return Array.isArray(args[0])
        ? args[0].some((entry) => asString(entry).toLowerCase() === asString(args[1]).toLowerCase())
        : asString(args[0]).toLowerCase().includes(asString(args[1]).toLowerCase());
    }
    throw new Error(`unsupported function ${name}()`);
  };

  function lookup(name) {
    return name.split('.').reduce((value, part) => {
      if (part === '*') {
        if (value == null) return null;
        if (!Array.isArray(value)) throw new Error(`.* on a non-array: ${name}`);
        return value;
      }
      if (Array.isArray(value)) return value.map((entry) => (entry == null ? null : entry[part]));
      if (value == null) return null;
      return value[part];
    }, context);
  }

  function skipSpaces() {
    while (src[pos] === ' ') pos += 1;
  }

  function parsePrimary() {
    skipSpaces();
    if (src[pos] === '(') {
      pos += 1;
      const value = parseOr();
      skipSpaces();
      if (src[pos] !== ')') throw new Error(`expected ) at ${pos}: ${src.slice(pos)}`);
      pos += 1;
      return value;
    }
    if (src[pos] === "'") {
      const end = src.indexOf("'", pos + 1);
      if (end === -1) throw new Error('unterminated string literal');
      const value = src.slice(pos + 1, end);
      pos = end + 1;
      return value;
    }
    const match = /^[A-Za-z][A-Za-z0-9_.\-*]*/.exec(src.slice(pos));
    if (!match) throw new Error(`cannot parse at ${pos}: ${src.slice(pos)}`);
    const name = match[0];
    pos += name.length;
    skipSpaces();
    if (src[pos] === '(') {
      pos += 1;
      const args = [];
      skipSpaces();
      if (src[pos] !== ')') {
        args.push(parseOr());
        skipSpaces();
        while (src[pos] === ',') {
          pos += 1;
          args.push(parseOr());
          skipSpaces();
        }
      }
      if (src[pos] !== ')') throw new Error(`expected ) after ${name}( at ${pos}`);
      pos += 1;
      return callFunction(name, args);
    }
    if (name === 'true') return true;
    if (name === 'false') return false;
    if (name === 'null') return null;
    return lookup(name);
  }

  function parseUnary() {
    skipSpaces();
    if (src[pos] === '!') {
      pos += 1;
      return !parseUnary();
    }
    return parsePrimary();
  }

  function parseEquality() {
    const left = parseUnary();
    skipSpaces();
    if (src.startsWith('==', pos)) {
      pos += 2;
      return left === parseUnary();
    }
    if (src.startsWith('!=', pos)) {
      pos += 2;
      return left !== parseUnary();
    }
    return left;
  }

  function parseAnd() {
    let left = parseEquality();
    for (;;) {
      skipSpaces();
      if (!src.startsWith('&&', pos)) return left;
      pos += 2;
      // Parse the right side even when left is already false: the parser must
      // always advance, like GitHub's (only evaluation short-circuits).
      const right = parseEquality();
      left = left && right;
    }
  }

  function parseOr() {
    let left = parseAnd();
    for (;;) {
      skipSpaces();
      if (!src.startsWith('||', pos)) return left;
      pos += 2;
      const right = parseAnd();
      left = left || right;
    }
  }

  const result = parseOr();
  skipSpaces();
  if (pos !== src.length) throw new Error(`trailing input at ${pos}: ${src.slice(pos)}`);
  return result;
}

// Permissive fixture: every non-lane gate is held open, so each table case's
// outcome is decided by the shared tier-and-event condition alone.
function fixture({ tier, event, head = 'feature/change', base = 'develop', author = 'an-agent[bot]', heavy = 'true', action, labels = [] }) {
  const eventAction = action ?? (event === 'pull_request' ? 'synchronize' : 'checks_requested');
  return {
    cancelled: false,
    inputs: {
      nix_build: true,
      nix_validate: true,
      python_ci: true,
      ansible_ci: true,
      tofu_ci: true,
      nix_skip_deps_only: false,
      profile: '',
    },
    needs: {
      changes: {
        result: 'success',
        outputs: {
          nix: 'true',
          markdown: 'true',
          python: 'true',
          ansible: 'true',
          terraform: 'true',
          extra: 'true',
          test_tier: 'full',
          production_pr: 'true',
          'is-deps-only': 'false',
          'is-flake-lock-change': 'true',
          'is-nix-source-change': 'true',
          'profile-unmapped': 'false',
        },
      },
      scope: { result: 'success', outputs: { ci: 'full', molecule: 'full' } },
      lane: { result: 'success', outputs: { lane: 'normal', tier, heavy_jobs: heavy, fast_path: 'false' } },
    },
    github: {
      event_name: event,
      head_ref: event === 'pull_request' ? head : '',
      base_ref: event === 'pull_request' ? base : '',
      event: event === 'pull_request'
        ? { action: eventAction, repository: { default_branch: 'develop' }, pull_request: { user: { login: author }, labels: labels.map((name) => ({ name })) } }
        : { action: eventAction, repository: { default_branch: 'develop' } },
    },
  };
}

const CASES = [
  { name: 'hot pull_request without preflight runs fast checks only', tier: 'hot', event: 'pull_request', runs: false },
  { name: 'hot merge_group runs the heavy jobs in the queue', tier: 'hot', event: 'merge_group', runs: true },
  { name: 'hot pull_request labeled preflight runs the heavy jobs', tier: 'hot', event: 'pull_request', labels: ['preflight'], runs: true },
  { name: 'hot push runs the heavy jobs (the post-merge run)', tier: 'hot', event: 'push', runs: true },
  { name: 'hot fast lane skips the heavy jobs in the queue', tier: 'hot', event: 'merge_group', heavy: 'false', runs: false },
  { name: 'standard pull_request runs the heavy jobs', tier: 'standard', event: 'pull_request', runs: true },
  { name: 'standard workflow_dispatch runs the heavy jobs (the nightly suite)', tier: 'standard', event: 'workflow_dispatch', runs: true },
  { name: 'standard fast lane skips the heavy jobs', tier: 'standard', event: 'pull_request', heavy: 'false', runs: false },
  { name: 'standard labeled event runs the heavy jobs, so the latest run always covers the head', tier: 'standard', event: 'pull_request', action: 'labeled', runs: true },
  { name: 'legacy pull_request keeps its heavy jobs', tier: 'legacy', event: 'pull_request', runs: true },
  { name: 'legacy merge_group keeps its heavy jobs', tier: 'legacy', event: 'merge_group', runs: true },
  { name: 'legacy release App pull request keeps its heavy jobs', tier: 'legacy', event: 'pull_request', author: 'jacobpevans-release-please[bot]', runs: true },
  { name: 'release App pull request on standard runs fast checks only', tier: 'standard', event: 'pull_request', author: 'jacobpevans-release-please[bot]', runs: false },
  { name: 'promotion into main on a git-flow repository runs fast checks only', tier: 'standard', event: 'pull_request', head: 'promote/2026-11-15', base: 'main', runs: false },
  { name: 'a promote/ branch into the default branch runs the heavy jobs', tier: 'standard', event: 'pull_request', head: 'promote/2026-11-15', runs: true },
  { name: 'a release-please branch name from another author runs the heavy jobs', tier: 'standard', event: 'pull_request', head: 'release-please--branches--main', runs: true },
];

test('every heavy job ANDs the one shared tier-and-event condition and waits for the lane', () => {
  for (const jobName of HEAVY_JOBS) {
    const job = workflow.jobs[jobName];
    assert.ok(job, `${jobName} exists`);
    assert.ok(job.if.includes(SHARED_CONDITION), `${jobName} carries the shared condition`);
    assert.equal(job.if.split(SHARED_CONDITION).length, 2, `${jobName} carries the shared condition exactly once`);
    assert.ok(job.needs.includes('lane'), `${jobName} waits for the lane job`);
  }
});

test('fast checks stay free of the tier-and-event condition', () => {
  for (const jobName of FAST_JOBS) {
    assert.doesNotMatch(
      JSON.stringify(workflow.jobs[jobName]),
      /needs\.lane\.outputs\.tier/,
      `${jobName} keeps its event behaviour`,
    );
  }
});

test('the tier-and-event table decides every heavy job the same way', () => {
  for (const jobName of HEAVY_JOBS) {
    const expression = workflow.jobs[jobName].if.replace(/^\$\{\{/, '').replace(/\}\}$/, '');
    for (const tableCase of CASES) {
      assert.equal(evaluate(expression, fixture(tableCase)), tableCase.runs, `${jobName}: ${tableCase.name}`);
    }
  }
});

test('a skipped heavy job never fails the gate', () => {
  const gateStep = workflow.jobs.gate.steps.find((step) => step.name === 'Aggregate results');
  assert.ok(gateStep, 'gate aggregates with the shared script');
  for (const jobName of HEAVY_JOBS) {
    assert.match(gateStep.env.CI_GATE_ALLOWED_SKIPS, new RegExp(`\\b${jobName}\\b`), `${jobName} stays in allowed-skips`);
  }
});
