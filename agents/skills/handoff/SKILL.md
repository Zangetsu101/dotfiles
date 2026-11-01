---
name: handoff
description: Hand the current conversation's work to a background agent that implements it.
argument-hint: "What should the background agent implement?"
disable-model-invocation: true
---

Write a spec for the work agreed in this conversation, complete enough for an agent with no access to this conversation to implement it. Publish it to the issue tracker if the repo has one, otherwise write it to the OS temp directory. If the user passed arguments, treat them as the scope.

Get the user's sign-off on the spec, then spawn a background agent to implement it with the implement skill, passing the spec path and working directory.
