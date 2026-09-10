- Pi extension changes: run `npm --prefix pi/agent run check`.
- Tracker or shared-skill changes: run `npm --prefix pi/agent run check`.
- User-facing prose: before sending it, use `/unslop`.
- Agent-facing documents: before creating or editing a skill, `AGENTS.md`, `CLAUDE.md`, tool metadata, or a document they point to, use `/writing-for-agents`.

## Agent skills

### Issue tracker

Issues are tracked as local markdown files under `.scratch/`. See `docs/agents/issue-tracker.md`.

### Triage labels

The canonical default triage vocabulary is used as local issue status metadata. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses a single-context layout. See `docs/agents/domain.md`.
