# Pi agent checks

```sh
npm --prefix pi/agent run check
npm --prefix pi/agent run test:mutation
```

Mutation testing is opt-in and separate from ordinary checks.

## Force messages to background agents

`background_agent_message` normally queues a message without interrupting work.
Set `force: true` to target the child's current Pi operation for cancellation
before submitting the recovery message. Delivery means Pi accepted the message,
not that the agent processed it. The interruption result is separate:
`not_needed`, `requested`, `confirmed`, `failed`, or `unconfirmed`. A timeout
is not proof of cancellation or delivery; the request may still be pending.
A failed cancellation still submits the message through the normal path.

Cancellation cannot undo partial edits or other effects. Pi's local bash tool
sends SIGKILL to its process group on Unix, with a direct-child fallback; a
process that escaped the group can survive, and other tools must honor their
abort signals themselves. Confirmation means the targeted Pi run stopped after
its abort signal was set, not that every external effect or detached process was
reversed. Pi's interactive abort may also restore already queued messages to the
editor. It does not deliberately terminate the child session or its delegated
background tasks.

## Synchronous bash deadlines

Bash calls default to 120 seconds. Supply a positive finite `timeout` in seconds for a known command that needs longer; Pi's existing maximum applies. For finite commands expected to take more than 60 seconds, prefer `background_monitor` so the agent remains available. Unknown runtimes start with bash.

Bash errors receive conditional timeout guidance because Pi's `tool_result` hook does not expose reliable timeout provenance; command output alone is not proof of a timeout. On timeout, Pi requests process-tree cancellation and waits for the shell to exit. Cancellation errors are suppressed by Pi, and descendants can escape or survive; termination of the entire tree is not confirmed. If cancellation fails, Pi may continue waiting rather than return at the deadline. Captured output is retained when Pi returns a timeout. Partial filesystem and external side effects may remain; check for them before retrying, and do not automatically retry. `background_monitor` manages its own task lifetime and does not inherit the synchronous bash deadline.

## Focused mutation testing

Paths are relative to `pi/agent`, even with `--prefix`:

```sh
npm --prefix pi/agent run test:mutation -- --mutate extensions/lib/task-check-in.ts --testFiles tests/task-check-in.test.ts
```

Select both source and test files: expanding `--mutate` does not expand
the configured tests.

Inspect `pi/agent/reports/mutation/index.html` after the run. Review surviving
changes for meaningful behavioral gaps. TAP attributes results to test files,
so it cannot identify individual redundant tests.

## Sandbox workaround

The mutation sandbox excludes `tsconfig.json` because Stryker's config rewriting
uses a TypeScript API unavailable in this repository's TypeScript 7.
Keep `run check` as the authoritative typecheck.
