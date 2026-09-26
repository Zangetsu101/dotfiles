---
status: accepted
---

# Organize Pi background work by task family

A user-started Root Pi and all of its descendant agents and monitors form a task family. Each family receives one lazily created tmux session so nested work remains traceable across pane boundaries and conversation resumes, while the Root Pi stays in the user’s existing workspace. Stable family, task, and parent identities live in metadata; tmux names remain human-readable presentation.

## Layout and navigation

Each agent occupies an independent window. Monitors occupy FIFO pool windows of at most eight panes each; additional pools are created without moving existing monitors, and empty pools are removed. Direct children use their label as their visible name, while nested children append their immediate parent with `←`; duplicate sibling labels receive stable numeric suffixes.

The Root Pi can operate on the whole family. An agent’s `/task` discovery and operations are confined to its subtree. `/task parent` navigates to the immediate parent, and `/task return` navigates to the Root Pi’s current pane. Notifications also travel only to the immediate parent.

## Lifecycle

Terminating or cleaning a node applies to its complete subtree. Cleaning is refused while any descendant is running. Settled agents remain interactive and may return to running for another assignment cycle; monitors exit after completion. A graceful Root Pi quit offers to keep or terminate active work and defaults to keeping it.

The family identity is persisted in the Pi conversation. Resuming the conversation reclaims the family, updates the Root Pi pane, and reconnects completion watchers. If the tmux session disappeared, previously running tasks become interrupted. Forked or cloned conversations receive new families. Empty family sessions are removed and recreated lazily. Tasks created by implementations predating this model are ignored rather than migrated.

Agent delegation remains limited to two generations by default, expressed as family configuration so the limit can change without altering the hierarchy model.

## Consequences

The tmux layout deliberately stays flat even though task ownership is hierarchical. Metadata, rather than window placement or names, is authoritative for identity, ancestry, routing, and lifecycle. This costs additional persistence and reconciliation logic, but avoids coupling nested task lifecycles to fragile tmux pane layouts and keeps visible names readable.
