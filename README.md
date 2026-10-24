# JacobPEvans/.github

Reusable GitHub workflows for generic CI, releases, linting, validation, and repository policy, with shared tooling and configuration.

AI review and agent automation workflows live in [JacobPEvans/.github-ai](https://github.com/JacobPEvans/.github-ai).

## Molecule reusable workflow

Callers of `.github/workflows/_molecule.yml` can set `galaxy_force_install` to
refresh built-in Galaxy requirements installs on cache hits, `pre_steps_script`
to run a caller-repository script before each scenario, `extra_env` to pass
non-secret `KEY=VALUE` lines to Molecule, and `static_checks` to run one shell
command per line once in the scenario discovery job. Caller scripts receive the
scenario name as their first argument. Repo-specific jobs remain in the caller.
