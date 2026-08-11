---
name: local-issue-tracker
description: Create and inspect canonical repository-local Markdown issues deterministically.
---

# Local issue tracker

Use the dependency-free executable directly; no installation or package step is required. It is `local-issue-tracker.mjs`, sitting beside this `SKILL.md`; its directory varies by install location, so read the absolute path of this `SKILL.md` and substitute that directory for `$TRACKER` in every command below.

```sh
node "$TRACKER/local-issue-tracker.mjs" create <effort> --title <title> [--triage <role>] [--type <type>] [--blocked-by <NN,NN>] [--body <text> | --body-file <path|->]
node "$TRACKER/local-issue-tracker.mjs" show <effort/NN|path|NN>
node "$TRACKER/local-issue-tracker.mjs" list <effort>
node "$TRACKER/local-issue-tracker.mjs" frontier <effort> [--triage <role>]
node "$TRACKER/local-issue-tracker.mjs" validate [<effort>]
node "$TRACKER/local-issue-tracker.mjs" migrate <effort> [--triage <role>]
node "$TRACKER/local-issue-tracker.mjs" migrate --repository [--triage <role>]
node "$TRACKER/local-issue-tracker.mjs" set-triage <issue> <role>
node "$TRACKER/local-issue-tracker.mjs" block <issue> <blocker>
node "$TRACKER/local-issue-tracker.mjs" unblock <issue> <blocker>
node "$TRACKER/local-issue-tracker.mjs" claim <issue>
node "$TRACKER/local-issue-tracker.mjs" release <issue>
node "$TRACKER/local-issue-tracker.mjs" resolve <issue>
```

`frontier` returns every open, unblocked issue by default; pass `--triage <role>` to select one canonical triage role. Add `--json` for stable machine-readable output. Add `--root <repository>` to override nearest-Git-root discovery. Bare numbers require the current directory to be inside that effort under `.scratch/`. Supported triage roles are `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`; supported types are `research`, `prototype`, `grilling`, and `task`.

Legacy issues remain read-only until explicitly migrated. Triage-status migration preserves that role; `claimed`, `resolved`, and missing statuses require `--triage`. Use `--repository` only for a deliberate repository-wide migration.

Creation preserves body input exactly. Prefer `--body-file -` and stdin for multiline prose. Resolution requires a non-empty existing `## Answer`; author that prose before running `resolve`. The executable alone manages the contiguous marked metadata header; author issue prose directly through its dedicated workflow.
