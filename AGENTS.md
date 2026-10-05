- Before editing Pi extensions, create a dedicated Git worktree and make all changes there. Keep the checkout used by the running Pi session unchanged until the changes are ready to deploy.
- Pi extension changes: run `npm --prefix pi/agent run check`.
- follow conventional commit messages.

## Agent skills

### Issue tracker

Issues are tracked as local markdown files under `.scratch/`. See `docs/agents/issue-tracker.md`.

### Triage labels

The canonical default triage vocabulary is used as local issue status metadata. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses a single-context layout. See `docs/agents/domain.md`.
