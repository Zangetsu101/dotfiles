# Sub-agent architecture

Status: Draft high-level architecture spec. Module responsibilities and behavioral contracts are agreed starting points. Method signatures are illustrative, not frozen. This is not yet an implementation-ready spec.

## Core contract

Delegate bounded work to an independently running, inspectable agent. Observe its progress, intervene when necessary, receive its outcome automatically, and reuse its session for follow-up assignments.

An agent session is long-lived. An assignment is one cycle of work within that session. Completing an assignment does not terminate the agent session.

This spec is based on `pi/agent/extensions/background-agent.ts` and its assignment helper. It proposes responsibility splits, not a required file layout.

## Modules and contracts

### 1. Agent coordinator

The parent-facing module owns delegation policy, agent relationships, and supervision.

Illustrative interface:

```ts
spawn(request): Promise<AgentHandle>
message(agentId, message, options?): Promise<DeliveryResult>
inspect(agentId): Promise<AgentSnapshot>
observe(listener): Unsubscribe
```

Contract:

- Spawning returns once the agent has started, not when its assignment finishes.
- Messaging supports steering and follow-up assignments.
- Messaging an agent outside the caller's task subtree fails.
- The coordinator enforces delegation grants and depth limits.
- Observations include progress, attention requests, overdue check-ins, and outcomes.
- Reconnecting restores supervision of existing agents.
- Disconnecting stops supervision without terminating agents.
- Callers do not need to know about status files, watchers, or mailbox locks.

### 2. Assignment lifecycle

The child-side module owns what working, blocked, and finished mean.

Illustrative interface:

```ts
report(report): Promise<void>
receive(instruction): Promise<void>
settle(finalOutput): Promise<void>
snapshot(): AssignmentSnapshot
```

Contract:

- Each assignment has its own identity and outcome.
- Work requires an initial progress report.
- Routine progress and requests for attention are distinct.
- Explicit completion and automatic settlement produce a consistent outcome.
- Follow-up work starts a new assignment without destroying the session.
- Pending instructions and tracked background work prevent premature settlement.
- Completing an assignment does not imply that its result was verified.

Lifecycle transitions and races between completion and follow-up messages should be tested through this module's interface.

### 3. Agent runtime

This module owns launching and communicating with the actual child process.

Illustrative interface:

```ts
launch(config): Promise<RuntimeHandle>
deliver(handle, instruction, options?): Promise<DeliveryResult>
inspect(handle): Promise<RuntimeSnapshot>
terminate(handle): Promise<void>
```

Contract:

- Launch creates an independently running, inspectable session.
- Delivery distinguishes acknowledged, rejected, and unknown outcomes.
- Acknowledged delivery means the instruction was submitted to Pi, not that the child acted on it.
- Force delivery reports interruption separately from message delivery.
- Cancellation is cooperative and never promises rollback.
- Runtime exit is distinct from assignment completion.
- The runtime provides attachment information without exposing tmux details to callers.

Tmux commands, mailboxes, operation IDs, and acknowledgement timeouts belong inside this implementation.

### 4. Pi integration

This module translates between Pi's tools and events and the other modules.

Contract:

- Register tools and validate their inputs.
- Translate Pi lifecycle events into assignment lifecycle calls.
- Turn coordinator observations into status displays and parent wake-ups.
- Enable or disable tools based on current capabilities.
- Render results and attachment instructions.
- Contain no assignment transition rules or mailbox protocol logic.

This should be a thin module. Most behavior currently in `background-agent.ts` should live elsewhere.

## Module relationships

```text
Parent Pi integration
    └── Agent coordinator
            └── Agent runtime
                    └── Child Pi integration
                            └── Assignment lifecycle
```

The coordinator observes the child's durable assignment state through the runtime's communication mechanism. The exact interfaces for that observation remain to be defined.

## Ownership summary

| Module | Owns |
| --- | --- |
| Agent coordinator | Who can delegate to whom, and when the parent needs attention |
| Assignment lifecycle | What the child is doing and whether its assignment has ended |
| Agent runtime | Whether the process exists and whether instructions reached it |
| Pi integration | How users and models interact with the other modules |

Persistence, notifications, and check-ins do not need separate high-level modules at this stage. Durable records are internal to the modules that own them, with exact ownership still to be settled. Check-in policy belongs to the coordinator. Displaying and delivering notifications belongs to Pi integration.

## Existing architectural constraints

This draft does not replace the accepted decisions in:

- [Organize Pi background work by task family](../adr/0001-organize-background-work-by-task-family.md).
- [Deliver background task check-ins at most once](../adr/0002-at-most-once-background-check-ins.md).

In particular, task family identity, task subtree scoping, immediate-parent notification routing, and the existing check-in delivery policy remain constraints. This draft does not select a new delegation depth default or change subtree termination semantics.

## Outside the current scope

The core contract does not require automatic worktree isolation, result verification, change merging, automatic assignment retries, concurrency limits, or cost budgets. These are not proposed additions in this draft.

## Before implementation

Resolve these details in later iterations:

- Shared types and assignment state transitions.
- Exact delivery, interruption, and error semantics.
- Ownership of durable records and recovery.
- Acceptance tests for the contracts.
