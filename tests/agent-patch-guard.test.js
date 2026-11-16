import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const guardWorkflow = readFileSync(
  new URL('../.github/workflows/_agent-patch-guard.yml', import.meta.url),
  'utf8',
);
const gateWorkflow = readFileSync(
  new URL('../.github/workflows/_ci-gate.yml', import.meta.url),
  'utf8',
);
const rulesText = readFileSync(
  new URL('../configs/agent-patch-guard/rules.yml', import.meta.url),
  'utf8',
);

// The semgrep JS-suppression rule scans **/*.js, which includes this file, so
// the fixture for that rule is assembled at runtime instead of written
// literally anywhere in this test.
const jsDirective = ['eslint', '-disable'].join('');

function stepScript(workflow, name) {
  const start = workflow.indexOf(`- name: ${name}`);
  assert.ok(start > 0, `step "${name}" exists in the workflow`);
  const next = workflow.indexOf('\n      - ', start + 1);
  const step = workflow.slice(start, next === -1 ? workflow.length : next);
  const run = step.match(/\n        run: \|\n([\s\S]*)$/);
  assert.ok(run, `step "${name}" has an inline run script`);
  return run[1];
}

// Runs an extracted step script the way GitHub Actions runs `shell: bash`:
// bash -e -o pipefail. GITHUB_OUTPUT points into a temp file whose key=value
// lines come back as an object.
function runScript(t, script, env = {}, options = {}) {
  const directory = options.directory ?? mkdtempSync(join(tmpdir(), 'agent-patch-guard-'));
  if (!options.directory) t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, 'github-output');
  const run = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
    cwd: options.cwd ?? directory,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, GITHUB_OUTPUT: output, ...env },
  });
  const outputs = {};
  if (existsSync(output)) {
    for (const line of readFileSync(output, 'utf8').match(/.+/g) ?? []) {
      const eq = line.indexOf('=');
      outputs[line.slice(0, eq)] = line.slice(eq + 1);
    }
  }
  return { run, outputs };
}

// A fake gh that applies the real jq to canned API responses, so the extracted
// policy step runs its own --jq expressions (same approach as the watchdog
// test). commits.json backs the PR commits endpoint, pr.json the PR endpoint.
function stubGh(t, commits, pr) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-patch-guard-gh-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'commits.json'), JSON.stringify(commits));
  writeFileSync(join(directory, 'pr.json'), JSON.stringify(pr));
  const gh = join(directory, 'gh');
  writeFileSync(
    gh,
    `#!/bin/sh
dir=$(dirname "$0")
expr=""
prev=""
for arg in "$@"; do
  [ "$prev" = "--jq" ] && expr="$arg"
  prev="$arg"
done
case "$*" in
  *"pulls/7/commits"*) jq -r "$expr" "$dir/commits.json" ;;
  *"pulls/7"*) jq -r "$expr" "$dir/pr.json" ;;
  *) exit 1 ;;
esac
`,
  );
  chmodSync(gh, 0o755);
  return directory;
}

const commit = (login) => ({ author: { login }, committer: { login } });

// ---------------------------------------------------------------------------
// Gate wiring
// ---------------------------------------------------------------------------

test('the gate declares the toggle with a true default and calls the reusable', () => {
  assert.match(gateWorkflow, /agent_patch_guard:\n {8}description: >-[\s\S]*? {8}default: true\n/);
  assert.match(
    gateWorkflow,
    /agent-patch-guard:\n {4}name: Agent Patch Guard\n {4}if: \$\{\{ inputs\.agent_patch_guard && github\.event_name == 'pull_request' \}\}\n {4}uses: \.\/\.github\/workflows\/_agent-patch-guard\.yml\n/,
  );
});

test('the Merge Gate needs the guard job and tolerates its event-based skips', () => {
  const needs = gateWorkflow.match(/needs: \[[^\]]*agent-patch-guard[^\]]*\]/);
  assert.ok(needs, `gate.needs lists agent-patch-guard: ${gateWorkflow.match(/    needs: \[[^\]]+/)}`);
  const skips = gateWorkflow.match(/CI_GATE_ALLOWED_SKIPS: >-([\s\S]*?)\n {10}CI_GATE_ALLOWED_FAILURES/);
  assert.ok(skips, 'allowed-skips block found');
  assert.match(skips[1], /agent-patch-guard/);
});

test('the reusable is a workflow_call with exactly the standard permissions', () => {
  assert.match(guardWorkflow, /^on:\n {2}workflow_call:/m);
  const blocks = [...guardWorkflow.matchAll(/(^|\n)( {0,4})permissions:\n((?: +[a-z-]+: [a-z]+\n)+)/g)];
  assert.ok(blocks.length >= 2, 'workflow and job permission blocks present');
  for (const [, , , block] of blocks) {
    assert.deepEqual(
      block.trim().split('\n').map((line) => line.trim()).sort(),
      ['contents: read', 'pull-requests: read'],
      `permissions block limited to the standard grant:\n${block}`,
    );
  }
});

test('the semgrep pin is an immutable-style release tag, not a moving one', () => {
  const tag = guardWorkflow.match(/default: (\d+\.\d+\.\d+)\n/);
  assert.ok(tag, `semgrep_tag default found: ${guardWorkflow.match(/default: \d+[^\n]*/)}`);
  assert.equal(tag[1], '1.184.0');
  assert.match(guardWorkflow, /"semgrep==\$\{SEMGREP_VERSION\}"/);
});

test('no workflow step bind-mounts a workspace or runner path into a container', () => {
  for (const [name, text] of [['_agent-patch-guard.yml', guardWorkflow], ['_ci-gate.yml', gateWorkflow]]) {
    assert.doesNotMatch(text, /docker run[\s\S]{0,200}?-v\s/, `${name} has no docker run -v`);
  }
});

// ---------------------------------------------------------------------------
// Enforcement policy: agent login matching and the approval label
// ---------------------------------------------------------------------------

test('unset logins variable enforces on any commit login ending in the bot suffix', (t) => {
  const gh = stubGh(t, [commit('renovate[bot]'), commit('alice')], { labels: [] });
  const { run, outputs } = runScript(t, stepScript(guardWorkflow, 'Decide enforcement and approval'), {
    GH_TOKEN: 'test', PATH: `${gh}:${process.env.PATH}`, REPO: 'example/repo', PR_NUMBER: '7', AGENT_LOGINS: '',
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(outputs.enforce, 'true');
  assert.equal(outputs.approved, 'false');
});

test('unset logins variable never enforces on human-only commits', (t) => {
  const gh = stubGh(t, [commit('alice'), { author: null, committer: { login: 'bob' } }], { labels: [] });
  const { run, outputs } = runScript(t, stepScript(guardWorkflow, 'Decide enforcement and approval'), {
    GH_TOKEN: 'test', PATH: `${gh}:${process.env.PATH}`, REPO: 'example/repo', PR_NUMBER: '7', AGENT_LOGINS: '',
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(outputs.enforce, 'false');
});

test('a configured logins list matches case-insensitively and wins over the bot default', (t) => {
  const gh = stubGh(t, [commit('OpenHands-Agent')], { labels: [] });
  const { run, outputs } = runScript(t, stepScript(guardWorkflow, 'Decide enforcement and approval'), {
    GH_TOKEN: 'test', PATH: `${gh}:${process.env.PATH}`, REPO: 'example/repo', PR_NUMBER: '7',
    AGENT_LOGINS: 'openhands-agent, some-other-bot',
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(outputs.enforce, 'true');

  const humanOnly = stubGh(t, [commit('alice')], { labels: [] });
  const quiet = runScript(t, stepScript(guardWorkflow, 'Decide enforcement and approval'), {
    GH_TOKEN: 'test', PATH: `${humanOnly}:${process.env.PATH}`, REPO: 'example/repo', PR_NUMBER: '7',
    AGENT_LOGINS: 'openhands-agent',
  });
  assert.equal(quiet.outputs.enforce, 'false');
});

test('a committer login enforces even when the author login is clean', (t) => {
  const gh = stubGh(t, [{ author: { login: 'alice' }, committer: { login: 'release-bot[bot]' } }], { labels: [] });
  const { outputs } = runScript(t, stepScript(guardWorkflow, 'Decide enforcement and approval'), {
    GH_TOKEN: 'test', PATH: `${gh}:${process.env.PATH}`, REPO: 'example/repo', PR_NUMBER: '7', AGENT_LOGINS: '',
  });
  assert.equal(outputs.enforce, 'true');
});

test('the approval label is detected on the pull request', (t) => {
  const gh = stubGh(t, [commit('alice')], { labels: [{ name: 'agent-patch-guard:approved' }] });
  const { outputs } = runScript(t, stepScript(guardWorkflow, 'Decide enforcement and approval'), {
    GH_TOKEN: 'test', PATH: `${gh}:${process.env.PATH}`, REPO: 'example/repo', PR_NUMBER: '7', AGENT_LOGINS: '',
  });
  assert.equal(outputs.approved, 'true');
});

// ---------------------------------------------------------------------------
// Rung 1 / 4 check steps: deleted tests and added scripts
// ---------------------------------------------------------------------------

const annotateEnv = (enforce, approved) => ({
  DELETED: JSON.stringify(['src/utils/legacy.test.js']),
  ADDED: JSON.stringify(['bin/provision.py']),
  ENFORCE: enforce,
  APPROVED: approved,
});

test('a deleted test file annotates as an error when enforced and records the violation', (t) => {
  const { run, outputs } = runScript(t, stepScript(guardWorkflow, 'Check deleted test files'), {
    ...annotateEnv('true', 'false'), DELETED: JSON.stringify(['src/utils/legacy.test.js']),
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /::error file=src\/utils\/legacy\.test\.js::Agent PR deleted a test file/);
  assert.equal(outputs.violated, 'true');
});

test('a deleted test file annotates as a warning when not enforcing or when approved', (t) => {
  for (const [enforce, approved] of [['false', 'false'], ['true', 'true']]) {
    const { run, outputs } = runScript(t, stepScript(guardWorkflow, 'Check deleted test files'), {
      ...annotateEnv(enforce, approved), DELETED: JSON.stringify(['src/utils/legacy.test.js']),
    });
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stdout, /::error/);
    assert.match(run.stdout, /::warning file=src\/utils\/legacy\.test\.js::/);
    assert.equal(outputs.violated, 'true');
  }
});

test('an added script under bin annotates and records the violation', (t) => {
  const { run, outputs } = runScript(t, stepScript(guardWorkflow, 'Check added scripts'), {
    ...annotateEnv('true', 'false'), ADDED: JSON.stringify(['bin/provision.py']),
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /::error file=bin\/provision\.py::Agent PR added a script under scripts\/ or bin\//);
  assert.equal(outputs.violated, 'true');
});

// ---------------------------------------------------------------------------
// Rung 2 reporting: semgrep findings transform
// ---------------------------------------------------------------------------

const findingsFixture = JSON.stringify({
  results: [
    { check_id: 'agent-patch-guard-python-suppression', path: 'pkg/app.py', start: { line: 12 }, extra: { message: 'Agent added a Python suppression' } },
    { check_id: 'agent-patch-guard-terraform-external-data', path: 'infra/main.tf', start: { line: 3 }, extra: { message: 'Agent added a Terraform data external block' } },
  ],
});

// Writes a findings file the way the semgrep step's --output produces one.
function findingsFile(t, content) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-patch-guard-sg-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'semgrep-findings.json');
  writeFileSync(file, content);
  return file;
}

test('semgrep findings become error annotations with rule, path and line when enforced', (t) => {
  const { run, outputs } = runScript(t, stepScript(guardWorkflow, 'Check semgrep findings'), {
    FINDINGS: findingsFile(t, findingsFixture), ENFORCE: 'true', APPROVED: 'false',
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /::error file=pkg\/app\.py,line=12,title=agent-patch-guard-python-suppression::Agent added a Python suppression/);
  assert.match(run.stdout, /::error file=infra\/main\.tf,line=3,/);
  assert.equal(outputs.count, '2');
  assert.equal(outputs.violated, 'true');
});

test('no semgrep findings records violated=false', (t) => {
  const { outputs } = runScript(t, stepScript(guardWorkflow, 'Check semgrep findings'), {
    FINDINGS: findingsFile(t, JSON.stringify({ results: [] })), ENFORCE: 'true', APPROVED: 'false',
  });
  assert.equal(outputs.violated, 'false');
});

// ---------------------------------------------------------------------------
// Rung 3: assertion-count drop on modified test files (real git fixture)
// ---------------------------------------------------------------------------

// Builds a git repo where `file` has `baseContent` at base and `headContent`
// at HEAD; returns the fixture directory and the base SHA.
function gitFixture(t, file, baseContent, headContent) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-patch-guard-git-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
  for (const args of [
    ['init', '-q', '-b', 'main'],
    ['config', 'user.email', 'test@example.com'],
    ['config', 'user.name', 'Test'],
  ]) assert.equal(git(...args).status, 0, args.join(' '));
  const write = (content) => {
    const target = join(directory, file);
    mkdirSync(target.slice(0, target.lastIndexOf('/')), { recursive: true });
    writeFileSync(target, content);
    assert.equal(git('add', file).status, 0);
  };
  write(baseContent);
  assert.equal(git('commit', '-qm', 'base').status, 0);
  write(headContent);
  assert.equal(git('commit', '-qam', 'head').status, 0);
  const base = git('rev-parse', 'HEAD~1');
  return { directory, base: base.stdout.trim() };
}

const baseTest = 'a();\nassert x;\nself.assertEqual(1, 1);\nexpect(z).toBe(2);\n';
const shrunkTest = 'a();\nassert x;\n';

test('a modified test file that loses assertions fails when enforced', (t) => {
  const { directory, base } = gitFixture(t, 'pkg/calc.test.js', baseTest, shrunkTest);
  const script = stepScript(guardWorkflow, 'Check assertion counts in modified test files');
  const { run, outputs } = runScript(t, script, {
    BASE_SHA: base, MODIFIED: JSON.stringify(['pkg/calc.test.js']), ENFORCE: 'true', APPROVED: 'false',
  }, { directory, cwd: directory });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /::error file=pkg\/calc\.test\.js::Agent PR dropped assertions in a test file \(3 -> 1\)/);
  assert.equal(outputs.violated, 'true');
});

test('an equal or grown assertion count passes, and new or non-test files are ignored', (t) => {
  const script = stepScript(guardWorkflow, 'Check assertion counts in modified test files');
  const grown = gitFixture(t, 'pkg/calc.test.js', baseTest, `${baseTest}expect(w).toBe(3);\n`);
  const grownRun = runScript(t, script, {
    BASE_SHA: grown.base, MODIFIED: JSON.stringify(['pkg/calc.test.js']), ENFORCE: 'true', APPROVED: 'false',
  }, { directory: grown.directory, cwd: grown.directory });
  assert.equal(grownRun.outputs.violated, 'false');

  const addedFile = gitFixture(t, 'pkg/new.test.js', 'x();\n', 'x();\nassert(x);\n');
  const addedRun = runScript(t, script, {
    BASE_SHA: addedFile.base, MODIFIED: JSON.stringify(['src/other.js']), ENFORCE: 'true', APPROVED: 'false',
  }, { directory: addedFile.directory, cwd: addedFile.directory });
  assert.equal(addedRun.outputs.violated, 'false', 'a file not in the modified list is not counted');

  const nonTest = gitFixture(t, 'src/app.js', baseTest, 'a();\n');
  const nonTestRun = runScript(t, script, {
    BASE_SHA: nonTest.base, MODIFIED: JSON.stringify(['src/app.js']), ENFORCE: 'true', APPROVED: 'false',
  }, { directory: nonTest.directory, cwd: nonTest.directory });
  assert.equal(nonTestRun.outputs.violated, 'false', 'a non-test path is not counted');
});

test('the assertion-count annotation severity derives from ENFORCE and APPROVED', (t) => {
  const script = stepScript(guardWorkflow, 'Check assertion counts in modified test files');
  const cases = [
    { enforce: 'true', approved: 'false', level: 'error', subject: 'Agent PR' },
    { enforce: 'true', approved: 'true', level: 'warning', subject: 'Agent PR' },
    { enforce: 'false', approved: 'false', level: 'warning', subject: 'PR' },
    { enforce: 'false', approved: 'true', level: 'warning', subject: 'PR' },
  ];
  for (const { enforce, approved, level, subject } of cases) {
    const { directory, base } = gitFixture(t, 'pkg/calc.test.js', baseTest, shrunkTest);
    const { run, outputs } = runScript(t, script, {
      BASE_SHA: base, MODIFIED: JSON.stringify(['pkg/calc.test.js']), ENFORCE: enforce, APPROVED: approved,
    }, { directory, cwd: directory });
    assert.equal(run.status, 0, run.stderr);
    assert.match(
      run.stdout,
      new RegExp(`::${level} file=pkg/calc\\.test\\.js::${subject} dropped assertions in a test file \\(3 -> 1\\)`),
    );
    if (level === 'warning') assert.doesNotMatch(run.stdout, /::error/);
    if (enforce === 'false') assert.doesNotMatch(run.stdout, /Agent PR/);
    assert.equal(outputs.violated, 'true');
  }
});

test('the assertion-count rung stays a 15-line shell body', () => {
  const script = stepScript(guardWorkflow, 'Check assertion counts in modified test files');
  const lines = script.split('\n').filter((line) => line.trim() && !line.trim().startsWith('#'));
  assert.ok(lines.length <= 15, `assertion-count shell body has ${lines.length} lines`);
});

// ---------------------------------------------------------------------------
// Verdict matrix
// ---------------------------------------------------------------------------

const verdictEnv = (over) => ({
  ENFORCE: 'true', APPROVED: 'false',
  DELETED_TEST: 'false', SEMGREP: 'false', ASSERTIONS: 'false', ADDED_SCRIPT: 'false',
  ...over,
});

test('an enforced violation fails the verdict and names the approval label', (t) => {
  const { run } = runScript(t, stepScript(guardWorkflow, 'Verdict'), verdictEnv({ DELETED_TEST: 'true' }));
  assert.equal(run.status, 1);
  assert.match(run.stdout, /agent-patch-guard:approved/);
});

test('the approval label turns an enforced violation into a pass', (t) => {
  const { run } = runScript(t, stepScript(guardWorkflow, 'Verdict'), verdictEnv({ APPROVED: 'true', SEMGREP: 'true' }));
  assert.equal(run.status, 0, run.stderr);
});

test('a non-agent PR passes with violations recorded', (t) => {
  const { run } = runScript(t, stepScript(guardWorkflow, 'Verdict'), verdictEnv({ ENFORCE: 'false', ADDED_SCRIPT: 'true' }));
  assert.equal(run.status, 0, run.stderr);
});

test('an enforced clean PR passes', (t) => {
  const { run } = runScript(t, stepScript(guardWorkflow, 'Verdict'), verdictEnv({}));
  assert.equal(run.status, 0, run.stderr);
});

// ---------------------------------------------------------------------------
// Semgrep rules: fixture emulation
//
// The authoritative run is the pinned semgrep container in CI (pattern-regex,
// unanchored search). These fixtures emulate exactly that semantics with JS
// RegExp on the rules file's own patterns, so a typo in a rule cannot pass
// this suite silently.
// ---------------------------------------------------------------------------

function parseRules(source) {
  const rules = {};
  const blocks = source.split(/^ {2}- id: /m).slice(1);
  for (const block of blocks) {
    const id = block.slice(0, block.indexOf('\n')).trim();
    const raw = block.match(/^ {4}pattern-regex: (.+)$/m);
    assert.ok(raw, `rule ${id} has a pattern-regex`);
    // YAML single-quoted scalars escape '' -> '; the fixtures below contain
    // no quotes, so stripping the surrounding quotes is enough to recover the
    // regex semgrep will compile.
    const value = raw[1].trim();
    assert.match(value, /^'[^']*'$/, `rule ${id} pattern is a single-quoted scalar`);
    const include = [...block.matchAll(/^ {8}- "(.+)"$/gm)].map((m) => m[1]);
    assert.ok(include.length > 0, `rule ${id} scopes paths.include`);
    rules[id] = { pattern: value.slice(1, -1).replaceAll("''", "'"), include };
  }
  return rules;
}

const ruleFixtures = {
  'agent-patch-guard-terraform-external-data': {
    matches: ['data "external" "runner" {\n  program = ["${path.module}/query.sh"]\n}'],
    misses: ['resource "external" "x" {}', 'data "http" "spec" {}'],
  },
  'agent-patch-guard-tflint-suppression': {
    matches: ['# tflint-ignore: aws_instance_invalid_type\nresource "aws_instance" "x" {}', '# tflint-ignore-file: module_version'],
    misses: ['resource "aws_instance" "x" {}'],
  },
  'agent-patch-guard-python-suppression': {
    matches: ['x = load()  # noqa: E501', 'token = get_token()  # nosec', 'y: int = q()  # type: ignore[union-attr]', 'def f():  # pragma: no cover'],
    misses: ['def covered():\n    return 1'],
  },
  'agent-patch-guard-shell-suppression': {
    matches: ['rm -rf "$dir" # shellcheck disable=SC2115'],
    misses: ['rm -rf "$dir"'],
  },
  'agent-patch-guard-js-suppression': {
    matches: [`// ${jsDirective}-next-line no-console\nconsole.log(1);`],
    misses: ['// eslint config lives in the root', 'console.log(1);'],
  },
  'agent-patch-guard-yaml-suppression': {
    matches: ['tags:\n  - skip_ansible_lint', 'tasks:\n  - name: x  # noqa: yaml[line-length]'],
    misses: ['tags:\n  - always'],
  },
  'agent-patch-guard-python-test-skip': {
    matches: ['@pytest.mark.skip(reason="flaky")', '@pytest.mark.xfail', 'pytest.skip("later")', '@unittest.skip("old")'],
    misses: ['def test_xfail_case():\n    assert True', 't.Skipf("no")'],
  },
  'agent-patch-guard-go-test-skip': {
    matches: ['func TestX(t *testing.T) {\n\tt.Skip("wip")\n}'],
    misses: ['t.Skipf("formatted %s", x)', 'func skipper() {}'],
  },
};

test('every rule matches its guard fixture and no benign fixture', () => {
  const rules = parseRules(rulesText);
  assert.deepEqual(Object.keys(ruleFixtures).sort(), Object.keys(rules).sort());
  for (const [id, { matches, misses }] of Object.entries(ruleFixtures)) {
    const re = new RegExp(rules[id].pattern);
    for (const sample of matches) assert.ok(re.test(sample), `${id} should match: ${JSON.stringify(sample)}`);
    for (const sample of misses) assert.ok(!re.test(sample), `${id} should not match: ${JSON.stringify(sample)}`);
  }
});

test('the YAML rule excludes the guard rule directory and workflow files so the rules do not self-match', () => {
  assert.match(rulesText, /exclude:\n {8}- "configs\/agent-patch-guard\/\*\*"\n {8}- "\.github\/workflows\/\*\*"/);
});

// Emulates the guard's own artifacts being scanned: every file this feature
// ships is checked against each rule whose paths include it, the way semgrep
// sees them in this repo's own CI (rules.yml and the workflows are excluded
// from the YAML rule; the test file carries no literal directive anywhere).
// Any hit here would fail this repo's own enforced CI.
test('the guard artifacts on this hub repo trip none of the rules', () => {
  const artifacts = [
    '.github/workflows/_agent-patch-guard.yml',
    '.github/workflows/_ci-gate.yml',
    'configs/agent-patch-guard/rules.yml',
    'tests/agent-patch-guard.test.js',
  ];
  const rules = parseRules(rulesText);
  const re = (id) => new RegExp(rules[id].pattern);
  const hits = [];
  for (const file of artifacts) {
    const content = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const [id, { include }] of Object.entries(rules)) {
      const includeMatch = include.some((glob) => {
        const source = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '(?:.*/)?').replace(/\*/g, '[^/]*');
        return new RegExp(`^${source}$`).test(file);
      });
      if (!includeMatch) continue;
      if (id === 'agent-patch-guard-yaml-suppression') {
        if (file === 'configs/agent-patch-guard/rules.yml' || file.startsWith('.github/workflows/')) continue;
      }
      if (re(id).test(content)) hits.push(`${id} matched ${file}`);
    }
  }
  assert.deepEqual(hits, []);
});
