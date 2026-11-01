---
name: implement
source: https://github.com/mattpocock/skills/tree/main/skills/engineering/implement
description: "Workflow for any code change: features, fixes, refactors, specs, or tickets. Use whenever you are about to edit code."
---

Implement the work the user described, whether in conversation, a spec, or tickets.

Use /tdd where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

When changing logic or its behavioral tests, check for an existing mutation-testing command. If available, run it against the changed logic after ordinary tests pass. Review surviving mutations for missing behavioral coverage and add tests for meaningful gaps. Report the scope, results, and unresolved gaps; if a focused run is unavailable or impractical, report why it was skipped.

Once the implementation passes, use /deslop to clean the diff. Rerun the affected checks after its edits.

Then use /code-review to review the cleaned work.

Commit your work to the current branch.
