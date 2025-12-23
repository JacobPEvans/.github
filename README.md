# .github

Default community health files, issue templates, and shared configurations for all JacobPEvans repositories.

## What This Repo Provides

Files in this repository automatically apply as defaults to all other public repositories that don't have their own versions:

| File | Purpose |
|------|---------|
| `ISSUE_TEMPLATE/*.yml` | Standardized issue forms with required fields |
| `labels.yml` | Canonical label definitions (synced via automation) |

## Label System

All repositories use a consistent labeling taxonomy.

### Required Labels (enforced via issue templates)

Every issue must have:
- **At least one** `type:*` label
- **Exactly one** `priority:*` label
- **Exactly one** `size:*` label

### Label Categories

#### Type Labels (`type:*`)

| Label | Description | Semver |
|-------|-------------|--------|
| `type:bug` | Something isn't working | PATCH |
| `type:feature` | New feature or request | MINOR |
| `type:breaking` | Breaking changes | MAJOR |
| `type:docs` | Documentation only changes | - |
| `type:chore` | Maintenance, dependencies, tooling | - |
| `type:ci` | CI/CD pipeline changes | - |
| `type:test` | Adding or correcting tests | - |
| `type:refactor` | Code change with no functional change | - |
| `type:perf` | Performance improvements | - |

#### Priority Labels (`priority:*`)

| Label | Description |
|-------|-------------|
| `priority:critical` | Urgent - requires immediate attention |
| `priority:high` | Should be addressed soon |
| `priority:medium` | Normal workflow |
| `priority:low` | Address when time permits |

#### Size Labels (`size:*`)

| Label | Description |
|-------|-------------|
| `size:xs` | Trivial change, <1 hour |
| `size:s` | Simple change, 1-4 hours |
| `size:m` | Moderate effort, 1-2 days |
| `size:l` | Significant work, 3-5 days |
| `size:xl` | Major effort, 1+ weeks |

#### AI Workflow Labels (`ai:*`)

| Label | Description |
|-------|-------------|
| `ai:created` | AI-generated issue - requires human approval |
| `ai:ready` | Human-approved and ready for any AI agent to implement |

**Logic:** `ai:created` alone means the issue needs human review. `ai:created` + `ai:ready` means it's approved for work.

#### Triage Labels

| Label | Description |
|-------|-------------|
| `duplicate` | This issue already exists |
| `invalid` | This doesn't seem right |
| `wontfix` | This will not be worked on |
| `question` | Further information is requested |

## Syncing Labels to Other Repos

Labels are synced using [EndBug/label-sync](https://github.com/EndBug/label-sync). To sync labels to a repository:

```bash
# One-time sync from this repo to another
gh label clone JacobPEvans/.github -R JacobPEvans/TARGET_REPO --force
```

## Issue Templates

Issue templates enforce the required label structure through dropdown fields. Templates are provided for:

- Bug Report (`type:bug`)
- Feature Request (`type:feature`)
- Documentation (`type:docs`)
- Chore/Maintenance (`type:chore`)

Blank issues are disabled to ensure all issues follow the template structure.
