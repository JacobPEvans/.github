# Label System

All JacobPEvans repositories use a consistent labeling taxonomy defined in [`.github/labels.yml`](../.github/labels.yml).
This system ensures standardized issue classification, effort estimation, and workflow management across all projects.

## Overview

Labels are organized into five categories, each serving a specific purpose:

- **Type labels** categorize the kind of change and map to semantic versioning
- **Priority labels** indicate urgency for work prioritization
- **Size labels** provide effort estimation for planning
- **AI workflow labels** track AI-generated issues and approval state
- **Triage labels** help with administrative issue management

Labels are enforced through [issue templates](../.github/ISSUE_TEMPLATE/).
They are automatically applied via the [auto-label-issues.yml](../.github/workflows/auto-label-issues.yml) GitHub Actions workflow.

## Required Labels

### Issues

Every issue **must** have:

- **At least one** `type:*` label (can have multiple for complex changes)
- **Exactly one** `priority:*` label
- **Exactly one** `size:*` label

These requirements are enforced through dropdown fields in issue templates, ensuring consistent labeling from the moment an issue is created.

### Pull Requests

Every PR **must** have:

- **At least one** `type:*` label (can have multiple for complex changes)
- **Exactly one** `priority:*` label
- **Exactly one** `size:*` label

Unlike issues, PR labels are applied manually by the author or reviewers.
[Pull request templates](../.github/PULL_REQUEST_TEMPLATE/) include checklist sections that prompt contributors to apply appropriate labels.

## Label Categories

### Type Labels (`type:*`)

**Purpose**: Categorizes the kind of change and maps to semantic versioning for release planning.

| Label            | Description                             | Semver Impact |
| ---------------- | --------------------------------------- | ------------- |
| `type:bug`       | Something isn't working                 | PATCH         |
| `type:feature`   | New feature or request                  | MINOR         |
| `type:breaking`  | Breaking changes                        | MAJOR         |
| `type:docs`      | Documentation only changes              | -             |
| `type:chore`     | Maintenance, dependencies, tooling      | -             |
| `type:ci`        | CI/CD pipeline changes                  | -             |
| `type:test`      | Adding or correcting tests              | -             |
| `type:refactor`  | Code change with no functional change   | -             |
| `type:perf`      | Performance improvements                | -             |
| `type:security`  | Security vulnerability or hardening     | PATCH         |

**Note**: Type labels align with [Conventional Commits](https://www.conventionalcommits.org/) and semantic versioning to automate release management.

### Priority Labels (`priority:*`)

**Purpose**: Indicates urgency and helps with work prioritization and sprint planning.

| Label                | Description                           |
| -------------------- | ------------------------------------- |
| `priority:critical`  | Urgent - requires immediate attention |
| `priority:high`      | Should be addressed soon              |
| `priority:medium`    | Normal workflow                       |
| `priority:low`       | Address when time permits             |

### Size Labels (`size:*`)

**Purpose**: Effort estimation for planning, workload balancing, and velocity tracking.

| Label      | Description      | Time Estimate |
| ---------- | ---------------- | ------------- |
| `size:xs`  | Trivial change   | <1 hour       |
| `size:s`   | Simple change    | 1-4 hours     |
| `size:m`   | Moderate effort  | 1-2 days      |
| `size:l`   | Significant work | 3-5 days      |
| `size:xl`  | Major effort     | 1+ weeks      |

**Note**: Time estimates are guidelines. Actual effort may vary based on complexity and familiarity with the codebase.

### Workflow Labels

**Purpose**: Tracks issue and PR lifecycle states, including AI-generated content and readiness for development.

#### AI Workflow Labels (`ai:*`)

| Label        | Description                                    |
| ------------ | ---------------------------------------------- |
| `ai:created` | AI-generated - requires human approval         |
| `ai:ready`   | Human-approved - ready for AI agent to work on |

**State Logic**:

- `ai:created` alone → Issue/PR needs human review before work begins
- `ai:created` + `ai:ready` → Issue/PR has been approved and is ready for implementation

This two-label system ensures AI agents can create issues autonomously while maintaining human oversight.

#### AI Review Labels

| Label              | Description                                          |
| ------------------ | ---------------------------------------------------- |
| `ai:reviewed`      | AI final review completed on this PR                 |
| `ai:skip-review`   | Opt out of all automated AI reviews                  |

These labels support automated PR review workflows.
`ai:reviewed` is applied by CI after an AI review pass completes.
`ai:skip-review` can be applied by a PR author to opt out of automated reviews on a per-PR basis.

#### Development Readiness Labels

| Label | Description |
| --- | --- |
| `ready-for-dev` | Ready for development - all requirements clarified |
| `good-first-issue` | Good for newcomers - well-scoped and documented |

### Triage Labels

**Purpose**: Administrative labels for issue lifecycle management.

| Label        | Description                      |
| ------------ | -------------------------------- |
| `duplicate`  | This issue already exists        |
| `invalid`    | This doesn't seem right          |
| `wontfix`    | This will not be worked on       |
| `question`   | Further information is requested |

## Color Standards

All label colors **must** use [Tailwind CSS palette](https://tailwindcss.com/docs/customizing-colors) hex values (without `#`).
This ensures visual consistency and makes colors easy to verify against a well-known reference.

**Color assignment guidelines**:

- Each `type:*` label has a unique Tailwind color for instant visual identification
- `priority:*` labels use a heat map gradient (red/critical → green/low)
- `size:*` labels use a green intensity gradient (light/xs → dark/xl)
- AI review labels use muted/neutral tones to avoid confusion with type or priority labels

When adding new labels, pick a Tailwind color that is visually distinct from existing labels in the same category.

## Syncing Labels to Repositories

Labels are **not inherited** from the `.github` repository like community health files.
They must be explicitly synced to each repository.

The canonical source of truth is [`.github/labels.yml`](../.github/labels.yml).
All sync methods should deploy **from this file**, not from another repo's current label state.

### Automated Sync (Recommended)

The [label-sync](../.github/workflows/label-sync.yml) GitHub Actions workflow reads `labels.yml` and deploys labels to all repositories automatically.
It runs on every push to `main` that modifies `labels.yml`, and can be triggered manually via `workflow_dispatch`.

To trigger a manual sync:

```bash
gh workflow run label-sync.yml -R JacobPEvans/.github
```

### Post-Sync Cleanup

After syncing, check for legacy GitHub default labels that conflict with the canonical set.
Migrate any issues using legacy labels before deleting them:

```bash
# Check for usage before deleting
gh issue list -R JacobPEvans/REPO --label "bug" --state all --json number,title

# Migrate if needed
gh issue edit NUMBER -R JacobPEvans/REPO --remove-label "bug" --add-label "type:bug"
```

Legacy labels to check:
`bug` → `type:bug`, `enhancement` → `type:feature`, `documentation` → `type:docs`,
`good first issue` → `good-first-issue`, `help wanted` → remove.

## Issue Template Integration

Issue templates in [`../.github/ISSUE_TEMPLATE/`][issue-templates] enforce the required label structure through a combination of frontmatter and dropdown fields:

[issue-templates]: ../.github/ISSUE_TEMPLATE/

- **Type labels**: Automatically applied via template frontmatter (`labels: ["type:feature"]`)
- **Priority labels**: Selected by issue author via dropdown field
- **Size labels**: Selected by issue author via dropdown field

### Available Templates

| Template           | Auto-Applied Label | File                  |
| ------------------ | ------------------ | --------------------- |
| Bug Report         | `type:bug`         | `bug_report.yml`      |
| Feature Request    | `type:feature`     | `feature_request.yml` |
| Documentation      | `type:docs`        | `documentation.yml`   |
| Chore/Maintenance  | `type:chore`       | `chore.yml`           |
| Security Report    | `type:security`    | `security.yml`        |

Each template includes required dropdown fields for priority and size, ensuring every issue receives complete labeling at creation time.

### Automated Label Application

The [`../.github/workflows/auto-label-issues.yml`][auto-label-workflow] GitHub Actions workflow automatically extracts priority and size labels from dropdown selections.
It then applies them to newly created issues.
This automation eliminates manual labeling and ensures consistency.

[auto-label-workflow]: ../.github/workflows/auto-label-issues.yml

**Blank issues are disabled** via `config.yml` to ensure all issues follow the template structure and receive proper labels.

## Pull Request Label Requirements

Pull request labels follow the same taxonomy as issues but are applied differently:

- **Type labels**: Matched with conventional commit format in PR title (e.g., `feat:` → `type:feature`)
- **Priority labels**: Selected by PR author from required checklist
- **Size labels**: Selected by PR author from required checklist

[Pull request templates](../.github/PULL_REQUEST_TEMPLATE/) include:

- Conventional commit format guidance in comments
- Type-specific sections for comprehensive documentation
- Checklist section prompting for label application
- Links to [LABELS.md](LABELS.md) for label definitions

### PR Title Format

PR titles must follow [Conventional Commits](https://www.conventionalcommits.org/) format:

**Format**: `type(scope): brief description`

This format enables:

- Automated semantic versioning based on commit types
- Consistent relationship between PR type and `type:*` labels
- Clear communication of change scope

**Examples**:

- `feat(api): add user authentication` → `type:feature`
- `fix(ui): resolve button alignment` → `type:bug`
- `docs(readme): update installation` → `type:docs`

## Canonical Source

The single source of truth for label definitions is [`.github/labels.yml`](../.github/labels.yml) in this repository.
All documentation, tooling, and automation references this file.

When updating labels:

1. Modify [`.github/labels.yml`](../.github/labels.yml) first
2. Update this documentation to reflect changes
3. Push to `main` — the [label-sync workflow](../.github/workflows/label-sync.yml) deploys to all repos automatically
4. Update issue templates if new label categories are added

---

**See Also**:

- [`.github/labels.yml`](../.github/labels.yml) - Canonical label definitions with colors and descriptions
- [`.github/ISSUE_TEMPLATE/`](../.github/ISSUE_TEMPLATE/) - Issue forms that enforce label requirements
- [`.github/workflows/auto-label-issues.yml`](../.github/workflows/auto-label-issues.yml) - Automated label application workflow
- [Managing labels - GitHub Docs](https://docs.github.com/en/issues/using-labels-and-milestones-to-track-work/managing-labels)
