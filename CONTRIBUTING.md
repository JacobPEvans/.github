# Contributing

This repository holds the reusable workflows and shared configuration used across the owner's
repositories, so pull requests are read by humans and automated agents that do not share a session.

## Pull request descriptions

Describe every pull request with the template's six sections, in order: Objective, Approach, Changes,
Verification, Related, Trace.

- Objective: the outcome the change achieves and for whom. Approach: what was chosen, why this way, and
  what else was considered. Changes: the specific changes as bullets.
- Verification: the commands or checks that were run and what they returned; say plainly what was not run.
- Related: full URLs of pull requests in other repositories belonging to the same piece of work, plus the
  tracker task reference if there is one; write `None` when there is none. No bare numbers.
- Trace: exactly one line, `lead: <id> worker: <id>`, where each id is the last 8 characters of the
  authoring session's identifier and the worker part is the delegated job or run identifier; `none` stands
  for a missing part. A person writing by hand writes `lead: none worker: none`.
- Never include incident or outage narrative, security weaknesses or findings, credentials, host names,
  addresses, internal topology, or names of private systems; those belong in private trackers.
- Keep the body under 400 words unless the change needs more, and title the pull request
  `type(scope): description`.
