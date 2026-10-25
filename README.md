# JacobPEvans/.github

Reusable GitHub workflows for generic CI, releases, linting, validation, and repository policy, with shared tooling and configuration.

AI review and agent automation workflows live in [JacobPEvans/.github-ai](https://github.com/JacobPEvans/.github-ai).

## Reusable workflows

| Workflow | Purpose | Inputs |
| --- | --- | --- |
| [`_flake-lock-fresh.yml`](.github/workflows/_flake-lock-fresh.yml) | Check owned flake inputs and optionally age-check root GitHub inputs. | `runner_label`, `max_age_days`. |
| [`_org-index.yml`](.github/workflows/_org-index.yml) | Org index and `llms.txt`. | `visibility_scope`, `output_path`. |

`visibility_scope` accepts `public` or `all`; `output_path` defaults to
`profile/README.md`.

The caller needs the `GH_ACTION_RELEASE_PLEASE_PRIVATE_KEY` secret and the
`GH_ACTION_RELEASE_PLEASE_APP_ID` organization variable. The App needs contents
and pull request write on the caller repository, plus repository metadata read
for `visibility_scope: all`. Public scope lists repositories with the workflow
token. All scope mints an organization read token. Both open the index pull
request with a caller-repository token.

`JacobPEvans/.github` calls this workflow weekly and on manual dispatch with
`visibility_scope: public`. For `JacobPEvans/.github-private`, the caller is:

```yaml
name: Organization Index

on:
  schedule:
    - cron: "17 8 * * 1"
  workflow_dispatch:

permissions: {}

jobs:
  org-index:
    permissions: {}
    uses: JacobPEvans/.github/.github/workflows/_org-index.yml@v1
    with:
      visibility_scope: all
    secrets:
      GH_ACTION_RELEASE_PLEASE_PRIVATE_KEY: ${{ secrets.GH_ACTION_RELEASE_PLEASE_PRIVATE_KEY }}
```

## Molecule reusable workflow

Callers of `.github/workflows/_molecule.yml` can set `galaxy_force_install` to
refresh built-in Galaxy requirements installs on cache hits, `pre_steps_script`
to run a caller-repository script before each scenario, `extra_env` to pass
non-secret `KEY=VALUE` lines to Molecule, and `static_checks` to run one shell
command per line once in the scenario discovery job. Caller scripts receive the
scenario name as their first argument. `pull_request_timeout_minutes` and
`pull_request_discover_timeout_minutes` set per-caller PR timeouts while keeping
the existing 25- and 15-minute defaults; both are capped at 360 minutes.
`molecule_roles_path` can add a
caller-repository-relative role path; its empty default uses the configured
Ansible home. Repo-specific jobs remain in the caller.
