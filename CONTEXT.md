# Dotfiles Domain

This context defines project-specific language for Pi background work.

## Background Work

**Assignment**:
One cycle of work in a background agent, ending in an explicit outcome report or automatic settlement. A settled agent remains interactive and can begin another assignment for follow-up work.
_Avoid_: Task, when referring to a single work cycle rather than the background agent's lifetime

**Root Pi**:
The user-started Pi process from which a task family descends. It remains in the user’s existing workspace and is represented as the family’s virtual root.
_Avoid_: Root agent, parent session

**Task family**:
A Root Pi and all background agents and monitors descended from it. Its background tasks share one dedicated tmux session, including tasks created by nested agents.
_Avoid_: Owner group, pane group

**Task subtree**:
A Pi node and every background task descended from it. Task discovery and ordinary task operations are confined to the caller’s subtree.
_Avoid_: Owner tasks, pane tasks
