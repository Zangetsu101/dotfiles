---
name: visual-pr
description: Create or update a PR with a concise visual change outline.
source: https://github.com/humanlayer/skills/tree/main/plugins/visual-pr
---

# Visual PR

Create or update the PR for the current task with a description that explains why the change exists and how it works.

1. Find the PR for the current work. If there is none, create one when the branch is ready, following the repository's git safety rules. If the current branch has no relevant work, ask the user which PR to use.
2. Read the complete diff, relevant task context, and enough surrounding code to account for every changed behavior. Read [the description template](references/pr_description_template.md) and [show-me](../show-me/SKILL.md) for the visual conventions. The description is ready when every section in the template is filled and the outline explains the implementation without a file-by-file changelog.
3. Publish the description and verify the PR body matches it. Return the PR URL and a brief summary of what changed.
