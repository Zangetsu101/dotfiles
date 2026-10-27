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
