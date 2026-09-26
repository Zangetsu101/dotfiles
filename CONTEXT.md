# Dotfiles Domain

This context defines project-specific language for local issue coordination and Pi background work.

## Language

**Issue**:
A Markdown work item stored within an effort’s `issues/` directory. Its stable identity is its effort and effort-scoped number; its title and filename slug may change.
_Avoid_: Ticket (when referring to the persisted artifact)

**Triage role**:
The kind of actor or input an issue needs, recorded on every issue independently from its lifecycle state. New issues default to `needs-triage` unless their role is already known.
_Avoid_: Status, state

**Lifecycle state**:
An issue’s execution progress: `open`, `claimed`, or `resolved`.
_Avoid_: Status, triage state

**Frontier**:
The `ready-for-agent`, `open` issues whose blockers are all resolved and which can therefore be claimed for implementation.
_Avoid_: Queue, backlog

**Orchestrator**:
The single coordinator that claims frontier issues and distributes them to workers. Individual worker ownership is not persisted; `claimed` is sufficient to reserve an issue.
_Avoid_: Claimant, assignee

**Effort**:
A directory under `.scratch/` containing a specification or map and its related issues.
_Avoid_: Feature (when the work may be research, planning, or maintenance)

## Background Work

**Root Pi**:
The user-started Pi process from which a task family descends. It remains in the user’s existing workspace and is represented as the family’s virtual root.
_Avoid_: Root agent, parent session

**Task family**:
A Root Pi and all background agents and monitors descended from it. Its background tasks share one dedicated tmux session, including tasks created by nested agents.
_Avoid_: Owner group, pane group

**Task subtree**:
A Pi node and every background task descended from it. Task discovery and ordinary task operations are confined to the caller’s subtree.
_Avoid_: Owner tasks, pane tasks
