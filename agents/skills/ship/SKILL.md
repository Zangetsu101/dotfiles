---
name: ship
description: Ship a branch by watching CI and merging its pull request.
disable-model-invocation: true
---

Use the open PR for the branch. If there is none, open one and use the [pr skill](../pr/SKILL.md) to write its body.

Watch CI. Merge when checks pass for the current commit. Report the PR link and the result or blocker.
