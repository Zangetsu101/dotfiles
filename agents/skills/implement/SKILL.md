---
name: implement
source: https://github.com/mattpocock/skills/tree/main/skills/engineering/implement
description: "Implement any code change, such as a feature or a fix, whether it comes from a plain request in chat, a spec, or tickets."
---

Implement the work the user described.

Before you edit any code, collect the before half of the [evidence](EVIDENCE.md). Do this on both paths.

First, check the size of the change. A change is small when it meets all of these conditions:

- It changes logic in at most one place, or it is a mechanical change such as a rename or a move.
- It keeps stored data, schemas, public interfaces, and dependencies as they are.
- Existing tests cover the behavior that it changes.

For a small change, make the change, collect the after evidence, tell the user that you used the short path of this skill, and stop. For all other changes, continue with the steps below.

Use /tdd where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

When changing logic or its behavioral tests, check for an existing mutation-testing command. If available, run it against the changed logic after ordinary tests pass. Review surviving mutations for missing behavioral coverage and add tests for meaningful gaps. Report the scope, results, and unresolved gaps; if a focused run is unavailable or impractical, report why it was skipped.

Once the implementation passes, use /deslop to clean the diff. Rerun the affected checks after its edits. Then collect the after evidence.

Commit the cleaned work to the current branch.

Then use /code-review to review the committed work.
