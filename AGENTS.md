# AGENTS.md

Central config repo. Provides defaults for all JacobPEvans repos.

## Auto-Inherited Files

- `ISSUE_TEMPLATE/*.yml` → Issue forms
- `labels.yml` → Label definitions

## Labels (Required per issue)

- `type:*` - One+ required: bug|feature|breaking|docs|chore|ci|test|refactor|perf
- `priority:*` - Exactly one: critical|high|medium|low
- `size:*` - Exactly one: xs|s|m|l|xl

## AI Labels

- `ai:created` alone → Needs human review
- `ai:created` + `ai:ready` → Approved for work

## Sync Labels to Repo

```bash
gh label clone JacobPEvans/.github -R JacobPEvans/TARGET --force
```
