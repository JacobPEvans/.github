const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const workflow = readFileSync(join(__dirname, '..', '.github', 'workflows', 'pr-policy.yml'), 'utf8');
const step = workflow.match(/- name: Require an Assisted-by trailer on agent pull requests\n([\s\S]*?)(?=\n      #|\n      - name: )/)[1];
const script = step.slice(step.indexOf('run: |\n') + 'run: |\n'.length).replace(/^ {10}/gm, '');

// Runs the step's script against a one-commit repository; returns its exit code.
function runOn(message) {
  const dir = mkdtempSync(join(tmpdir(), 'assisted-by-'));
  try {
    const git = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args]);
    git('init', '-q');
    git('commit', '-q', '--allow-empty', '-m', message);
    try {
      execFileSync('bash', ['-c', script], { cwd: dir, stdio: 'pipe' });
      return 0;
    } catch (error) {
      return error.status;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the trailer step passes a head commit that carries an Assisted-by trailer', () => {
  assert.equal(runOn('feat: add a thing\n\nBody text.\n\nAssisted-by: Claude:some-model\n'), 0);
});

test('the trailer step fails a head commit without the trailer, also when the body only mentions it', () => {
  assert.equal(runOn('feat: add a thing\n'), 1);
  assert.equal(runOn('feat: add a thing\n\nAssisted-by: Claude appears mid-body.\n\nMore text follows here.\n'), 1);
});

test('the trailer step runs only for agent pull requests outside the legacy tier', () => {
  assert.match(step, /github\.event_name == 'pull_request'/);
  assert.match(step, /contains\(fromJSON\('\["standard", "hot"\]'\), github\.event\.repository\.custom_properties\.merge_tier\)/);
  assert.match(step, /!contains\(fromJSON\('\["renovate\[bot\]", "jacobpevans-release-please\[bot\]"\]'\), github\.event\.pull_request\.user\.login\)/);
  assert.match(step, /contains\(github\.event\.pull_request\.labels\.\*\.name, 'auto-revert'\)/);
  assert.match(step, /startsWith\(github\.event\.pull_request\.head\.ref, 'agent\/'\)/);
  assert.match(step, /startsWith\(github\.event\.pull_request\.head\.ref, 'topic\/'\)/);
});
