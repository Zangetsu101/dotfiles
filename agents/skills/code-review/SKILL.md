---
name: code-review
description: "Review changes since a commit, branch, tag, or merge-base on two independent axes: repository standards and the originating spec. Use for branch, PR, work-in-progress, or review-since requests."
---

Review the diff between `HEAD` and a user-supplied fixed point on two independent axes:

- **Standards**: conformity with documented repository standards and the review baseline.
- **Spec**: fidelity to the originating issue or spec.

Run both reviews in parallel sub-agents, then report them separately.

The issue tracker should have been provided to you. If `docs/agents/issue-tracker.md` is missing, tell the user to run `/setup-matt-pocock-skills`.

## Process

### 1. Pin the fixed point

Use the fixed point the user supplied: a commit SHA, branch, tag, `main`, `HEAD~5`, or equivalent. Ask for it if absent.

Resolve it with `git rev-parse <fixed-point>`. Record these commands for both reviewers:

- Diff: `git diff <fixed-point>...HEAD`
- Commits: `git log <fixed-point>..HEAD --oneline`

Confirm the diff is non-empty. Stop on a bad ref or empty diff.

### 2. Identify the spec source

Look in this order:

1. Issue references in commit messages, fetched through `docs/agents/issue-tracker.md`.
2. A path supplied by the user.
3. A file under `docs/`, `specs/`, or `.scratch/` matching the branch or feature.
4. Ask the user where the spec is.

If the user confirms no spec exists, skip the Spec reviewer and report `no spec available`.

### 3. Identify standards sources

Find repository documents that govern the changed code, such as `CODING_STANDARDS.md`, or `CONTRIBUTING.md`. Record their paths; the Standards reviewer will read them.

### 4. Dispatch both reviewers in parallel

Resolve `standards-review.md` and `spec-review.md` relative to this skill's directory and pass their absolute paths in the prompts.

Standards reviewer prompt:

> You are the Standards reviewer. Carry out this review directly. Read `<absolute-standards-review-path>` and follow it. Use diff command `<diff-command>` and commit-list command `<commit-command>`. The repository standards sources are: `<paths, or "none found">`.

Spec reviewer prompt:

> You are the Spec reviewer. Carry out this review directly. Read `<absolute-spec-review-path>` and follow it. Use diff command `<diff-command>` and commit-list command `<commit-command>`. The originating spec is at `<path>` / has these fetched contents: `<contents>`.

Each prompt must explicitly assign the reviewer role and instruct that reviewer to read its review file. Dispatch both at once so their contexts remain independent.

### 5. Aggregate

Present the returned reports under `## Standards` and `## Spec`, verbatim or lightly cleaned. Keep their findings separate and preserve their internal ordering.

End with one line giving the finding count and worst issue within each axis, if any. Do not select a winner across axes.

## Why two axes

A change can satisfy every standard while implementing the wrong behavior, or implement the requested behavior while violating repository conventions. Separate reports keep either axis from masking the other.
