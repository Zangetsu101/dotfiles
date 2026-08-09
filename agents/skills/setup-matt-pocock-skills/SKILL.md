---
name: setup-matt-pocock-skills
description: Set up local Markdown issue tracking and domain docs for the engineering skills.
disable-model-invocation: true
---

# Setup Matt Pocock's Skills

Configure every repository with:

- local Markdown issues managed through the `local-issue-tracker` skill;
- the canonical triage roles in `triage-labels.md`;
- a user-selected single- or multi-context domain-doc layout.

## Process

### 1. Explore

Read the repository’s existing configuration:

- `AGENTS.md` and `CLAUDE.md` at the root;
- `CONTEXT.md` and `CONTEXT-MAP.md`;
- root and context-specific `docs/adr/` directories;
- `docs/agents/`;
- `.scratch/`;
- monorepo signals: `pnpm-workspace.yaml`, a `workspaces` field in `package.json`, or populated `packages/*/src` directories.

Account for the instruction file already in use, any existing `## Agent skills` block, the current domain layout, prior generated docs, local efforts that setup must preserve.

### 2. Select the domain layout

Summarise what is present and missing, including the fixed local tracker and canonical triage vocabulary.

When exploration found no monorepo signals, select **single-context** without asking: one `CONTEXT.md` plus `docs/adr/` at the repository root. This fits almost every repository.

When exploration found monorepo signals, explain why engineering skills need domain language and ADR locations, then ask the user to choose:

- **Single-context** — one `CONTEXT.md` plus `docs/adr/` at the repository root.
- **Multi-context** — a root `CONTEXT-MAP.md` points to per-context `CONTEXT.md` files.

Wait for the user’s answer only when monorepo signals require a choice. This step completes when the layout is selected.

### 3. Confirm the generated configuration

Show the user a draft of:

- the `## Agent skills` block for the existing instruction file;
- `docs/agents/issue-tracker.md` from the local tracker seed;
- `docs/agents/triage-labels.md` from the canonical triage seed;
- `docs/agents/domain.md` adapted to the selected layout.

Wait for the user’s edits or approval. This step completes when the user approves all four artifacts.

### 4. Write

Use the instruction file already established by the repository:

- Prefer `AGENTS.md` when it exists.
- Otherwise use `CLAUDE.md` when it exists.
- Ask which file to create when neither exists.

Update an existing `## Agent skills` block in place and preserve surrounding user content. Use this block:

```markdown
## Agent skills

### Issue tracker

Issues are tracked as local Markdown files under `.scratch/` and structured operations use the `local-issue-tracker` skill. See `docs/agents/issue-tracker.md`.

### Triage labels

The canonical local triage vocabulary is used. See `docs/agents/triage-labels.md`.

### Domain docs

[one-line summary of the selected single- or multi-context layout]. See `docs/agents/domain.md`.
```

Write the docs from these seeds:

- [issue-tracker-local.md](./issue-tracker-local.md)
- [triage-labels.md](./triage-labels.md)
- [domain.md](./domain.md)

Adapt only the domain seed to the selected layout. Preserve existing local efforts. This step completes when the instruction block and all three docs match the approved draft.

### 5. Done

Report the instruction file and generated docs. State that engineering skills will read them and that rerunning setup regenerates the configuration.
