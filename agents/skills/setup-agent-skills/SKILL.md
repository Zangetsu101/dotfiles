---
name: setup-agent-skills
description: "Set up a repo for the agent skills: the domain docs layout and a local .scratch folder."
disable-model-invocation: true
---

# Setup Agent Skills

Set up the configuration for each repo that the agent skills use:

- **Domain docs**: where `CONTEXT.md` and the ADRs are, and the rules for reading them.
- **Scratch folder**: a `.scratch/` folder for local notes, specs and scripts. Git ignores it.

Explore, show the user what you found, get confirmation, and then write.

## Process

### 1. Explore

Read the current state of the repo:

- `AGENTS.md` and `CLAUDE.md` at the repo root. Does either file exist? Does either file have an `## Agent skills` section?
- `CONTEXT.md` and `CONTEXT-MAP.md` at the repo root.
- `docs/adr/` and all `src/*/docs/adr/` folders.
- `docs/agents/domain.md`, from an earlier run of this skill.
- `.scratch/`, whether `.gitignore` or `$(git rev-parse --git-common-dir)/info/exclude` already ignores it, and whether `.ignore` has `!/.scratch/`.
- Monorepo signals: a `pnpm-workspace.yaml` file, a `workspaces` field in `package.json`, or a `packages/*` folder where each package has its own `src/`.

### 2. Show the findings and ask

Tell the user what exists and what is missing. Then do the sections in order, with one answer for each section.

**Section A: Domain docs.** If there are no monorepo signals, use **single-context** (one `CONTEXT.md` and `docs/adr/` at the repo root). Do not ask. If there are monorepo signals, offer **multi-context** (a `CONTEXT-MAP.md` at the root that points to one `CONTEXT.md` for each context), and ask which layout the user wants.

**Section B: Scratch folder.** If `.scratch/` exists, Git ignores it and `.ignore` has `!/.scratch/`, skip this section. Otherwise, ask:

> Do you want a `.scratch/` folder for your local notes, specs and scripts? (recommended: **yes**)

### 3. Confirm

Show the user a draft of:

- The `## Agent skills` block (see step 4).
- The content of `docs/agents/domain.md`.

Let the user edit the drafts before you write them.

### 4. Write

**Select the file to edit:**

- If `CLAUDE.md` exists, edit it.
- If only `AGENTS.md` exists, edit it.
- If neither file exists, ask the user which file to create.

If the file already has an `## Agent skills` block, update the block in place. Keep the other sections of the file as they are.

The block:

```markdown
## Agent skills

### Domain docs

[one-line summary of the layout: "single-context" or "multi-context"]. See `docs/agents/domain.md`.

### Scratch folder

`.scratch/` holds local notes, specs and temporary scripts. Git ignores it, but `rg` searches it.
```

Include the `### Scratch folder` part only when the user said yes in Section B, or when the folder already exists.

Write `docs/agents/domain.md` from the template [domain.md](./domain.md). Keep only the file structure for the layout that the user selected.

If the user said yes in Section B:

1. Create `.scratch/`.
2. Add `/.scratch/` to `$(git rev-parse --git-common-dir)/info/exclude`. This file is local, so the ignore rule does not go into the shared `.gitignore`.
3. Add `!/.scratch/` to `.ignore` at the repo root. `rg` gives `.ignore` priority over `info/exclude`, so searches still find the files in `.scratch/`.
4. If Git does not track `.ignore`, also add `/.ignore` to `info/exclude`. If Git tracks `.ignore`, tell the user that the change is in a shared file.

### 5. Done

Tell the user which files you wrote. Tell them that they can edit `docs/agents/domain.md` directly.
