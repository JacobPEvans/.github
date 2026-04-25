# CLAUDE.md

## Repo Purpose

This is the `.github` community health repository for JacobPEvans. It
provides default community files (issue templates, PR templates,
CONTRIBUTING.md, etc.) that are automatically inherited by all public repos
that don't define their own versions.

## Key Files

- `renovate.json` — Renovate config extending `config:recommended` and local presets
- `.github/labels.yml` — Canonical label definitions deployed to all repos via `label-sync.yml`
- `.github/workflows/label-sync.yml` — Syncs `labels.yml` to all repos on push to main
- `.github/ISSUE_TEMPLATE/` — Issue forms (bug, feature, docs, chore); all require `priority` + `size` labels
- `.github/PULL_REQUEST_TEMPLATE/` — PR templates per change type; all require Conventional Commits format
- `docs/CONTRIBUTING.md` — Inherited contributing guidelines

## New repository onboarding

When Renovate (Mend) is enabled on a new public repo it auto-opens a "Configure
Renovate" PR that scaffolds a minimal `renovate.json` with only
`{"extends": ["config:recommended"]}`. **That on-board PR must not be merged
as-is.** Edit the renovate config to also extend the org preset:

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": [
    "config:recommended",
    "local>JacobPEvans/.github:renovate-presets"
  ]
}
```

Without `local>JacobPEvans/.github:renovate-presets`, the repo loses
`lockFileMaintenance`, the trusted-org auto-merge allow-list, the 3-day
default stabilization, the 0-day `vulnerabilityAlerts` automerge, and every
custom manager defined in `renovate-presets.json`.

This is verifiable with the audit one-liner:

```sh
for repo in $(gh repo list JacobPEvans --visibility public --limit 50 --json name --jq '.[].name'); do
  for f in renovate.json renovate.json5 .github/renovate.json; do
    body=$(gh api "repos/JacobPEvans/$repo/contents/$f" 2>/dev/null | jq -r '.content // empty' | base64 -d 2>/dev/null) || continue
    [ -z "$body" ] && continue
    if echo "$body" | grep -q "JacobPEvans/.github:renovate-presets"; then
      echo "OK   $repo ($f)"
    else
      echo "MISS $repo ($f)"
    fi
    break
  done
done | sort
```

Any `MISS` line is a repo that will silently fall behind on dependency
updates and security patches.

## Common Tasks

### Adding or modifying labels

Edit `.github/labels.yml`. Pushing to `main` triggers `label-sync.yml`, which deploys labels to all repos.

### Adding an issue template

Add a `.yml` file to `.github/ISSUE_TEMPLATE/`. It must include `priority` and `size` dropdown fields to match the label taxonomy.

### Updating reusable workflows

Workflows prefixed with `_` are reusable and called from other repos:

```yaml
uses: JacobPEvans/.github/.github/workflows/_name.yml@main
```

## Conventions

- Label names use `namespace:value` format (`type:bug`, `priority:high`, `size:m`)
- PR titles must follow Conventional Commits: `type(scope): description`
- Commits should be signed (required by PR templates)
