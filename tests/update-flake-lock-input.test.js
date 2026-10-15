const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const workflow = path.join(__dirname, '..', '.github', 'workflows', '_update-flake-lock.yml');
const workflowText = fs.readFileSync(workflow, 'utf8');
const inputBranchStart = workflowText.indexOf('          if [ -n "$INPUT" ]; then\n');
const inputBranchEnd = workflowText.indexOf('          if [ -n "$STALE_INPUTS" ]; then\n', inputBranchStart);

assert.notEqual(inputBranchStart, -1, 'workflow input branch exists');
assert.notEqual(inputBranchEnd, -1, 'workflow input branch ends before stale-input handling');

const inputBranch = workflowText
  .slice(inputBranchStart, inputBranchEnd)
  .split('\n')
  .map((line) => line.replace(/^ {10}/, ''))
  .join('\n');

test('targets a valid nested path and root input while rejecting invalid nested paths', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flake-lock-input-'));
  fs.writeFileSync(
    path.join(dir, 'flake.lock'),
    JSON.stringify({
      root: 'root',
      nodes: {
        root: { inputs: { nixDarwinPub: 'public', 'root-flake': 'root-flake-node' } },
        public: { inputs: { 'nix-ai': 'nix-ai-node' } },
        'nix-ai-node': { inputs: {} },
        'root-flake-node': { inputs: {} },
      },
    }),
  );
  const inputScript = `nix() { printf '%s\\n' "$@" > "$NIX_ARGS_FILE"; }\n${inputBranch}`;

  let runNumber = 0;
  const runInput = (input) => {
    const argsFile = path.join(dir, `nix-args-${runNumber++}`);
    const result = spawnSync('bash', ['-c', inputScript], {
      cwd: dir,
      env: {
        INPUT: input,
        STALE_INPUTS: '',
        CHANNELS_DIR: '',
        NIX_ARGS_FILE: argsFile,
        PATH: process.env.PATH,
      },
      encoding: 'utf8',
    });
    return { ...result, args: fs.existsSync(argsFile) ? fs.readFileSync(argsFile, 'utf8').trim().split('\n') : [] };
  };

  try {
    const nested = runInput('nixDarwinPub/nix-ai');
    assert.equal(nested.status, 0, nested.stdout + nested.stderr);
    assert.deepEqual(nested.args, ['flake', 'update', 'nixDarwinPub/nix-ai']);

    for (const input of [
      'nixDarwinPub/../nix-ai',
      'nixDarwinPub/nix..ai',
      '/nixDarwinPub/nix-ai',
      '-nixDarwinPub/nix-ai',
      'nixDarwinPub/ not-an-input',
      'nixDarwinPub/$(touch sentinel)',
      'nixDarwinPub/not-direct',
    ]) {
      const invalid = runInput(input);
      assert.equal(invalid.status, 1, `${input}: ${invalid.stdout}${invalid.stderr}`);
      assert.deepEqual(invalid.args, [], `${input} reached nix`);
    }
    assert.equal(fs.existsSync(path.join(dir, 'sentinel')), false);

    const root = runInput('root-flake');
    assert.equal(root.status, 0, root.stdout + root.stderr);
    assert.deepEqual(root.args, ['flake', 'update', 'root-flake']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
