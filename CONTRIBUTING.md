# Contributing

First off, thanks for considering contributing to this project. It's just me here, so any help is genuinely appreciated.

## The Short Version

1. Fork it
2. Create your feature branch (`git checkout -b feat/cool-thing`)
3. Commit your changes (`git commit -m 'Add some cool thing'`)
4. Push to the branch (`git push origin feat/cool-thing`)
5. Open a Pull Request

That's it. I'm not picky.

## Signing Your Commits

**Commit signing is required** for all contributions. This verifies that commits actually come from you.

### Getting Started with Commit Signing

If you've never signed commits before, don't worry—it only takes a few minutes to set up:

1. **Generate a GPG key** (if you don't have one): Follow [GitHub's guide on generating a GPG key](https://docs.github.com/en/authentication/managing-commit-signature-verification/generating-a-new-gpg-key)

2. **Configure Git to sign your commits**: After setting up your GPG key, tell Git to use it:
   ```bash
   git config user.signingkey <YOUR_GPG_KEY_ID>
   git config commit.gpgsign true
   ```
   (Replace `<YOUR_GPG_KEY_ID>` with your actual key ID from step 1)

3. **Add your public key to GitHub**: [Add your GPG key to your GitHub account](https://docs.github.com/en/authentication/managing-commit-signature-verification/adding-a-gpg-key-to-your-github-account)

Once set up, Git will automatically sign all your commits. Your PRs will show a "Verified" badge next to your commits.

**Need more help?** See GitHub's [complete guide to commit signature verification](https://docs.github.com/en/authentication/managing-commit-signature-verification).

## Reporting Issues

Found a bug? Something unclear? Open an issue. Describe what you expected, what happened instead, and any relevant context. Screenshots are nice but not required.

## Pull Requests

### Opening Your PR

When opening your PR:
- Describe what changes you made and why
- Reference any related issues with "Closes #X" or "Fixes #X"
- Keep the PR focused on a single feature or fix

### Before You Start

- Check if there's already an issue or PR for what you're planning
- For big changes, maybe open an issue first to discuss (or don't, I'm not your boss)

### Code Style

This repo has markdown linting via `markdownlint-cli2`. The pre-commit hooks will catch most issues, but if you want to check locally:

```bash
markdownlint-cli2 "**/*.md"
```

Follow the existing patterns in `agentsmd/`. If you're not sure about something, just make your best guess. I can always tweak it during review.

### Commit Messages

Use conventional commits if you remember:

- `feat:` for new features
- `fix:` for bug fixes
- `docs:` for documentation changes
- `refactor:` for code changes that don't add features or fix bugs

But honestly, as long as your commit message explains what you did, we're good.

## What Gets Accepted

Pretty much anything that:

- Improves the documentation
- Adds useful AI assistant workflows
- Fixes bugs or typos
- Makes the codebase more maintainable

I'll probably accept most reasonable PRs. This is a documentation repo, not a nuclear reactor.

## What Might Not Get Accepted

- Breaking changes without discussion
- Vendor-specific instructions that don't fit the multi-AI philosophy
- Changes that make the repo significantly more complex without clear benefit

## Development Setup

1. Clone the repo
2. Install pre-commit: `pip install pre-commit && pre-commit install`
3. Make changes
4. Commit and push

That's the whole setup. No build system, no dependencies to install, no configuration files to create.

## Questions?

Open an issue. I'll respond when I can.

---

*Thanks for reading this far. Most people don't.*
