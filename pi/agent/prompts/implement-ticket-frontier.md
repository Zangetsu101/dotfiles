---
description: Implement a dependency-ordered ticket set with bounded parallel sub-agents
argument-hint: "<ticket-directory>"
---
Implement every ticket in `$1` by working the dependency frontier with at most 3 background agents at once. Before starting, verify that `$1` is a ticket directory; ask for a corrected invocation if it is invalid.

Follow this loop until every ticket is resolved or the frontier is stalled:

1. Read the repository instructions, tracker conventions, source spec, and every ticket in the supplied directory. Account for every ticket's status, blockers, acceptance criteria, and approved test seams, and identify the exact ticket-level and repository-level acceptance commands before dispatching work.
2. Determine the current frontier: every unresolved ticket whose `Blocked by` tickets are resolved. If unresolved tickets remain and the frontier is empty, stop and report each unresolved ticket with the metadata or dependency preventing progress.
3. Claim frontier tickets durably, then start them with `background_agent`. Maintain at most 3 active agents, dispatch only unresolved and unblocked tickets, and give each agent exactly one claimed ticket. Tell each agent to:
   - preserve unrelated and concurrent working-tree changes;
   - use the ticket's approved test seams and implement behavior test-first;
   - run the ticket-level acceptance command;
   - check every acceptance criterion and append an `## Answer` after verification succeeds;
   - keep the ticket claimed; the parent owns final resolution.
4. When an agent finishes, review its diff, ticket, acceptance criteria, and answer, then independently run the ticket-level acceptance command. After all checks pass, set that ticket's status to `resolved`. For incomplete work, preserve useful changes and launch a follow-up agent for the same claimed ticket before resolving it.
5. After each verified resolution or agent failure, return to step 2. In case of failures, report, preserve useful work, and retry the same claimed ticket before its dependants enter the frontier.
6. After every ticket is resolved, run the repository-level acceptance command and report resolved tickets, changed behavior, and verification results.

Delegate ticket implementation to sub-agents; reserve the parent context for coordination, review, and independent verification. Treat durable ticket status and blocking metadata as authoritative, and recompute the frontier from disk.
