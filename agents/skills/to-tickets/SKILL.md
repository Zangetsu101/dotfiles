---
name: to-tickets
description: Break a plan, spec, or the current conversation into tracer-bullet issues with explicit blocking edges, then publish them through the local issue tracker.
disable-model-invocation: true
---

# To Tickets

Break a plan, spec, or conversation into a set of **tickets** — tracer-bullet vertical slices, each declaring the tickets that **block** it.

Read the repository’s issue-tracker and triage-role docs before publishing.

## Process

### 1. Gather context

Work from whatever is already in the conversation context. If the user passes a reference (a spec path, an issue number or URL) as an argument, fetch it and read its full body and comments.

### 2. Explore the codebase (optional)

If you have not already explored the codebase, do so to understand the current state of the code. Ticket titles and descriptions should use the project's domain glossary vocabulary, and respect ADRs in the area you're touching.

Look for opportunities to prefactor the code to make the implementation easier. "Make the change easy, then make the easy change."

### 3. Draft vertical slices

Break the work into **tracer bullet** tickets.

<vertical-slice-rules>

- Each slice cuts a narrow but COMPLETE path through every layer (schema, API, UI, tests) — vertical, NOT a horizontal slice of one layer
- A completed slice is demoable or verifiable on its own
- Each slice is sized to fit in a single fresh context window
- Any prefactoring should be done first

</vertical-slice-rules>

Give each ticket its **blocking edges** — the other tickets that must complete before it can start. A ticket with no blockers can start immediately.

**Wide refactors are the exception to vertical slicing.** A **wide refactor** is one mechanical change — rename a column, retype a shared symbol — whose **blast radius** fans across the whole codebase, so a single edit breaks thousands of call sites at once and no vertical slice can land green. Don't force it into a tracer bullet; sequence it as **expand–contract**. First expand: add the new form beside the old so nothing breaks. Then migrate the call sites over in batches sized by blast radius (per package, per directory), each batch its own ticket blocked by the expand, keeping CI green batch to batch because the old form still exists. Finally contract: delete the old form once no caller remains, in a ticket blocked by every migrate batch. When even the batches can't stay green alone, keep the sequence but let them share an integration branch that all block a final integrate-and-verify ticket — green is promised only there.

### 4. Quiz the user

Present the proposed breakdown as a numbered list. For each ticket, show:

- **Title**: short descriptive name
- **Blocked by**: which other tickets (if any) must complete first
- **What it delivers**: the end-to-end behaviour this ticket makes work

Ask the user:

- Does the granularity feel right? (too coarse / too fine)
- Are the blocking edges correct — does each ticket only depend on tickets that genuinely gate it?
- Should any tickets be merged or split further?

Iterate until the user approves the breakdown.

### 5. Publish through the local issue CLI

Load the `local-issue-tracker` skill and use its documented invocation.

1. Author each approved issue body from the template below.
2. Create every issue through the CLI in dependency order with `ready-for-agent` triage. Record each returned stable identity.
3. Add the approved blocking edges through CLI blocker operations after every issue has an identity.
4. Run CLI validation for the effort.

When the source is an existing issue, retain its stable identity in each child’s `## Parent` section. Preserve the parent’s content and lifecycle.

<issue-template>

## Parent

A stable identity or relative Markdown link for the parent issue, when one exists.

## What to build

The end-to-end behaviour this issue makes work from the user's perspective, rather than a layer-by-layer implementation list.

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2

</issue-template>

Describe behavior and acceptance at a stable abstraction level. When a prototype produced a decision-rich state machine, reducer, schema, or type shape that prose cannot preserve precisely, include only that essential excerpt and identify its prototype source.

Publishing completes when every approved issue exists with `ready-for-agent` triage, every blocker edge matches the approved graph, and CLI validation succeeds.
