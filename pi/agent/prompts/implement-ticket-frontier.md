---
description: Implement a dependency-ordered issue set with bounded parallel sub-agents
argument-hint: "<issue-directory>"
---
Implement every issue in `$1` by working the agent-ready dependency frontier with at most 3 background agents at once. Verify that `$1` is an effort’s issue directory and derive its stable effort identity. Ask for a corrected invocation when validation fails.

Load the `local-issue-tracker` skill and use its CLI for every structured issue query and mutation. Author issue prose through ordinary Markdown edits.

Follow this loop until every issue is resolved or the frontier is stalled:

1. Read the repository instructions, tracker conventions, source spec, and every issue body in the supplied directory. Query the JSON issue list for authoritative triage, lifecycle, and blocker metadata. Account for every issue’s acceptance criteria and approved test seams, and identify the exact issue-level and repository-level acceptance commands before dispatching work.
2. Query `frontier` with `--triage ready-for-agent --json`. If unresolved issues remain and this frontier is empty, stop and report each unresolved issue with the metadata or dependency preventing progress.
3. Claim frontier issues, then start them with `background_agent`. Maintain at most 3 active agents, dispatch only successfully claimed issues, and give each agent exactly one issue. Tell each agent to:
   - preserve unrelated and concurrent working-tree changes;
   - use the issue’s approved test seams and implement behavior test-first;
   - run the issue-level acceptance command;
   - verify every acceptance criterion and author or update `## Answer` after verification succeeds;
   - preserve managed metadata; the parent owns lifecycle mutations.
4. When an agent finishes, review its diff, issue, acceptance criteria, and answer, then independently run the issue-level acceptance command. Resolve the issue after all checks pass. For incomplete work, preserve useful changes and launch a follow-up agent for the same claimed issue.
5. Recompute the frontier after each resolution or agent failure. Retry failed claimed work before its dependants enter the frontier. When orchestration must stop without a follow-up owning a claimed issue, release it and report the reason.
6. After every issue resolves, validate the effort, run the repository-level acceptance command, and report resolved issues, changed behavior, and verification results.

Delegate issue implementation to sub-agents; reserve the parent context for orchestration, review, and independent verification.
