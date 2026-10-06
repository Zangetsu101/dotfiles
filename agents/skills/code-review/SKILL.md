---
name: code-review
source: https://github.com/mattpocock/skills/tree/main/skills/engineering/code-review
description: "Review committed ranges or staged changes against repository standards and the originating spec."
---

Review a committed range or the index against `HEAD` on two independent axes:

- **Standards**: conformity with documented repository standards and the review baseline.
- **Spec**: fidelity to the originating issue or spec.

## Process

### 1. Pin the review scope

If the user requests staged changes or the index against `HEAD`, use staged mode. Otherwise, use the supplied fixed point for a committed review: a commit SHA, branch, tag, `main`, `HEAD~5`, or equivalent. Ask for the scope if absent or ambiguous.

Record the mode and commands for both reviewers:

- **Committed**: resolve the fixed point with `git rev-parse <fixed-point>`. Diff: `git diff <fixed-point>...HEAD`. Commits: `git log <fixed-point>..HEAD --oneline`.
- **Staged**: diff: `git diff --cached HEAD`. Commit list: `none; uncommitted changes`. Only staged changes are in scope, including staged additions and deletions. Read index contents with `git show :<path>` when inspecting the reviewed version of a file; working-tree contents may include unstaged changes.

Confirm the selected diff is non-empty. Stop on a bad ref or empty diff.

### 2. Identify the spec source

Look in this order:

1. For committed mode, issue references in the selected commit messages. Resolve them using `docs/agents/issue-tracker.md` if available; otherwise, continue to another spec source.
2. A path supplied by the user.
3. A file under `docs/`, `specs/`, or `.scratch/` matching the branch or feature.
4. Ask the user where the spec is.

If the user confirms no spec exists, skip the Spec reviewer and report `no spec available`.

### 3. Identify standards sources

Check `~/.agents/CODING_STANDARDS.md` for global coding standards. Include it if present.

Find repository documents that govern the changed code, such as `CODING_STANDARDS.md` or `CONTRIBUTING.md`.

Record each source's absolute path and scope for the Standards reviewer.

### 4. Dispatch the applicable reviewers

Resolve `standards-review.md` and `spec-review.md` relative to this skill's directory and pass their absolute paths in the prompts.

Standards reviewer prompt:

> You are the Standards reviewer. Carry out this review directly. Read `<absolute-standards-review-path>` and follow it. Review mode: `<mode>`. File-version instructions: `<instructions from step 1>`. Diff command: `<diff-command>`. Commit list: `<commit-command or "none; uncommitted changes">`. The standards sources and their scopes are: `<absolute paths and scopes, or "none found">`.

Spec reviewer prompt:

> You are the Spec reviewer. Carry out this review directly. Read `<absolute-spec-review-path>` and follow it. Review mode: `<mode>`. File-version instructions: `<instructions from step 1>`. Diff command: `<diff-command>`. Commit list: `<commit-command or "none; uncommitted changes">`. The originating spec is at `<path>` / has these fetched contents: `<contents>`.

Always dispatch the Standards reviewer. Dispatch the Spec reviewer only when a spec is available. When both apply, dispatch them in parallel with independent contexts.

### 5. Aggregate

Present the returned reports under `## Standards` and `## Spec`, verbatim or lightly cleaned. Keep their findings separate and preserve their internal ordering.

End with one line giving the finding count and worst issue within each axis, if any. Do not select a winner across axes.
