---
name: handoff-implement
description: Hand the current conversation's work to a background agent that runs the implement skill.
argument-hint: "What should the background agent implement?"
disable-model-invocation: true
---

1. Write a handoff document following [`../handoff/SKILL.md`](../handoff/SKILL.md). Tailor it to the implementation: the agreed scope, decisions made, seams for tests, and open questions. If the user passed arguments, treat them as the scope.
2. Call `background_agent` with:
   - `task`: "Use the implement skill. Read the handoff document at `<path>` first; it is your spec." Add the working directory and branch or worktree the work belongs in.
   - `label`: a short name for the work.
   - `expectedCompletionMinutes`: your estimate for the full implement loop, including tests, deslop, and review.
3. Tell the user the handoff path and agent label, then return to the conversation. When the completion notification arrives, report the agent's outcome and commits.
