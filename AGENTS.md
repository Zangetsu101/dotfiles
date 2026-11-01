- If changes could disrupt running Pi sessions, implement them in a dedicated Git worktree in the current agent by default, leaving the checkout used by those sessions unchanged until deployment.
- follow conventional commit messages.

## Agent skills

### Issue tracker

Issues are tracked as local markdown files under `.scratch/`. See `docs/agents/issue-tracker.md`.

### Triage labels

The canonical default triage vocabulary is used as local issue status metadata. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses a single-context layout. See `docs/agents/domain.md`.
