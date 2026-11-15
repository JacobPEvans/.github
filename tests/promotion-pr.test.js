import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const workflow = readFileSync(
  fileURLToPath(new URL('../.github/workflows/_promotion-pr.yml', import.meta.url)),
  'utf8',
);

const SLACK_ACTION_SHA = 'dcb1066f776dd043e64d0e8ba94ca15cc7e1875d';

// Minimal indentation-based YAML reader for the subset these workflows use:
// nested mappings, sequences of mappings, block scalars, and plain or quoted
// scalars. It is deliberately strict so an unexpected construct fails loudly.
function parseYaml(source) {
  const lines = source.split('\n');
  let index = 0;

  const indentOf = (line) => line.length - line.trimStart().length;

  function nextContentLine() {
    while (index < lines.length) {
      const line = lines[index];
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) {
        index += 1;
        continue;
      }
      return line;
    }
    return null;
  }

  function parseScalar(raw) {
    let value = raw.trim();
    if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      return value.slice(1, -1).replaceAll("''", "'");
    }
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      return value.slice(1, -1);
    }
    value = value.replace(/\s+#.*$/, '').trim();
    if (value === '{}') return {};
    if (value === '[]') return [];
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (value === 'null' || value === '~' || value === '') return null;
    if (/^-?\d+$/.test(value)) return Number(value);
    return value;
  }

  function parseBlockScalar(headerIndent, style) {
    const collected = [];
    let blockIndent = null;
    while (index < lines.length) {
      const line = lines[index];
      if (line.trim() === '') {
        collected.push('');
        index += 1;
        continue;
      }
      const indent = indentOf(line);
      if (indent <= headerIndent) break;
      if (blockIndent === null) blockIndent = indent;
      collected.push(line.slice(blockIndent));
      index += 1;
    }
    while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop();
    const text = collected.join('\n');
    return style === '|-' ? text : `${text}\n`;
  }

  function parseMapping(indent) {
    const mapping = {};
    while (true) {
      const line = nextContentLine();
      if (line === null) break;
      const lineIndent = indentOf(line);
      if (lineIndent < indent) break;
      assert.equal(lineIndent, indent, `unexpected indentation: ${line}`);
      const trimmed = line.trim();
      assert.ok(!trimmed.startsWith('- '), `unexpected sequence item: ${line}`);
      const match = /^([^:]+):(?:\s+(.*))?$/.exec(trimmed);
      assert.ok(match, `unsupported mapping line: ${line}`);
      const key = match[1].trim();
      const rest = (match[2] ?? '').trim();
      index += 1;
      if (rest === '|' || rest === '|-') {
        mapping[key] = parseBlockScalar(indent, rest);
      } else if (rest === '') {
        const child = nextContentLine();
        mapping[key] =
          child !== null && indentOf(child) > indent ? parseNode(indentOf(child)) : null;
      } else {
        mapping[key] = parseScalar(rest);
      }
    }
    return mapping;
  }

  function parseSequence(indent) {
    const items = [];
    while (true) {
      const line = nextContentLine();
      if (line === null) break;
      const lineIndent = indentOf(line);
      if (lineIndent < indent) break;
      assert.equal(lineIndent, indent, `unexpected indentation: ${line}`);
      const trimmed = line.trim();
      if (!trimmed.startsWith('- ')) break;
      const content = trimmed.slice(2);
      if (/^[^:]+:(\s|$)/.test(content)) {
        lines[index] = `${' '.repeat(indent + 2)}${content}`;
        items.push(parseMapping(indent + 2));
      } else {
        index += 1;
        items.push(parseScalar(content));
      }
    }
    return items;
  }

  function parseNode(indent) {
    const line = nextContentLine();
    assert.notEqual(line, null, 'expected a YAML node');
    return line.trim().startsWith('- ') ? parseSequence(indent) : parseMapping(indent);
  }

  return parseNode(0);
}

const document = parseYaml(workflow);
const workflowCall = document.on.workflow_call;
const jobs = Object.values(document.jobs);
const steps = jobs.flatMap((job) => job.steps);
const runScripts = steps.filter((step) => typeof step.run === 'string').map((step) => step.run);
const greenJob = document.jobs['promotion-green'];
const greenRun = greenJob.steps.find((step) => step.id === 'promote').run;

test('full_suite_workflow is an optional string input defaulting to empty', () => {
  const input = workflowCall.inputs.full_suite_workflow;
  assert.ok(input, 'full_suite_workflow input exists');
  assert.equal(input.required, false);
  assert.equal(input.type, 'string');
  assert.equal(input.default, '');
});

test('slack_webhook_url is an optional workflow_call secret', () => {
  const secret = workflowCall.secrets.slack_webhook_url;
  assert.ok(secret, 'slack_webhook_url secret exists');
  assert.equal(secret.required, false);
});

test('GH_ACTION_RELEASE_PLEASE_PRIVATE_KEY stays a required secret', () => {
  const secret = workflowCall.secrets.GH_ACTION_RELEASE_PLEASE_PRIVATE_KEY;
  assert.ok(secret, 'GH_ACTION_RELEASE_PLEASE_PRIVATE_KEY secret exists');
  assert.equal(secret.required, true);
});

test('no step uses ntfy', () => {
  assert.doesNotMatch(workflow, /ntfy/i);
  assert.doesNotMatch(JSON.stringify(document), /ntfy/i);
  for (const step of steps) {
    assert.doesNotMatch(String(step.uses ?? ''), /ntfy/i);
    assert.doesNotMatch(String(step.run ?? ''), /ntfy/i);
  }
});

test('Slack steps use slackapi/slack-github-action pinned to the pattern SHA', () => {
  const slackSteps = steps.filter((step) =>
    String(step.uses ?? '').startsWith('slackapi/slack-github-action@'),
  );
  assert.ok(slackSteps.length >= 2, 'hotfix-stop and red-suite Slack steps exist');
  for (const step of slackSteps) {
    assert.equal(step.uses, `slackapi/slack-github-action@${SLACK_ACTION_SHA}`);
    assert.equal(step.with['webhook-type'], 'incoming-webhook');
    assert.equal(step.with.webhook, '${{ secrets.slack_webhook_url }}');
    assert.match(step.if, /env\.HAS_SLACK == 'true'/);
    assert.match(step.with.payload, /^text: /);
  }
  assert.equal(greenJob.env.HAS_SLACK, "${{ secrets.slack_webhook_url != '' }}");
});

test('the reuse lookup filters runs by head_sha and status=success', () => {
  const reuseLookup = greenRun
    .split('\n')
    .find((line) => line.includes('$runs_path?') && line.includes('status=success'));
  assert.ok(reuseLookup, 'a runs lookup with status=success exists');
  assert.match(greenRun, /runs_path="repos\/\$GH_REPO\/actions\/workflows\/\$FULL_SUITE_WORKFLOW\/runs"/);
  assert.match(reuseLookup, /head_sha=\$green_sha/);
  assert.match(greenRun, /select\(\.status == "completed" and \.conclusion == "success"\)/);
});

test('the legacy path is unchanged and the green path is permission-scoped', () => {
  assert.deepEqual(document.permissions, {});
  const legacyJob = document.jobs['promotion-pr'];
  assert.equal(legacyJob.if, "inputs.full_suite_workflow == ''");
  assert.equal(greenJob.if, "inputs.full_suite_workflow != ''");
  assert.equal(legacyJob['runs-on'], 'ubuntu-26.04');
  assert.equal(greenJob['runs-on'], 'ubuntu-26.04');
  assert.deepEqual(legacyJob.permissions, {});
  assert.deepEqual(greenJob.permissions, {});

  const legacyToken = legacyJob.steps.find((step) => step.id === 'token');
  const greenToken = greenJob.steps.find((step) => step.id === 'token');
  for (const token of [legacyToken, greenToken]) {
    assert.match(token.uses, /^actions\/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510/);
    assert.equal(token.with['private-key'], '${{ secrets.GH_ACTION_RELEASE_PLEASE_PRIVATE_KEY }}');
  }
  assert.equal(legacyToken.with['permission-contents'], 'read');
  assert.equal(legacyToken.with['permission-pull-requests'], 'write');
  assert.equal(legacyToken.with['permission-actions'], undefined);
  assert.equal(greenToken.with['permission-contents'], 'write');
  assert.equal(greenToken.with['permission-pull-requests'], 'write');
  assert.equal(greenToken.with['permission-actions'], 'write');

  const legacyRun = legacyJob.steps.find((step) => typeof step.run === 'string').run;
  assert.match(legacyRun, /--label release:in-progress/);
  assert.match(legacyRun, /chore: promote develop to main/);
  assert.doesNotMatch(greenRun, /release:in-progress/);
  assert.match(greenRun, /--title "release: promote \$promote_date"/);
  assert.match(greenRun, /gh pr merge "\$pr_url" --repo "\$GH_REPO" --auto --merge/);
  assert.match(greenRun, /sleep 30/);
  assert.ok(runScripts.every((script) => !script.includes('${{')));
});
