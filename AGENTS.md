- Pi extension changes: run `npm --prefix pi/agent run check`.
- Tracker or shared-skill changes: run `npm --prefix pi/agent run check`.
- Prompt changes (`AGENTS.md`, `CLAUDE.md`, tool metadata) verify:
  - leading words
  - positive phrasing
  - observable required action (dead man's rule)

## Agent skills

### Issue tracker

Issues are tracked as local markdown files under `.scratch/`; pull requests are not a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

The canonical default triage vocabulary is used as local issue status metadata. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses a single-context layout. See `docs/agents/domain.md`.
