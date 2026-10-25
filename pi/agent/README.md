# Pi agent checks

```sh
npm --prefix pi/agent ci
npm --prefix pi/agent run check
npm --prefix pi/agent run test:mutation
```

`check` runs the ordinary tests, TypeScript check, and dependency synchronization
check. Mutation testing is opt-in and is not part of `check` or a commit hook.

## Mutation testing

StrykerJS core and its maintained official TAP runner are pinned to 10.1.1.
Use Node 22.18+ on the Node 22 line (measured with 22.19.0); the locked Babel
8 dependencies also support Node 24.11+. Native Node type stripping runs the
existing `node:test` files without a runner migration or transpilation step.

The bounded default mutates `extensions/lib/task-check-in.ts` and the deterministic
family identity module `extensions/lib/background-family.ts`, using their two
dedicated test files. This is a behavioral baseline, not a score gate.

Focused runs (paths are relative to `pi/agent`, even with `--prefix`):

```sh
npm --prefix pi/agent run test:mutation -- --mutate extensions/lib/task-check-in.ts --testFiles tests/task-check-in.test.ts
npm --prefix pi/agent run test:mutation -- --mutate extensions/lib/background-family.ts --testFiles tests/background-family.test.ts
# Restrict mutation generation to a source range; still run the dedicated tests:
npm --prefix pi/agent run test:mutation -- --mutate extensions/lib/task-check-in.ts:71-83 --testFiles tests/task-check-in.test.ts
```

These are supported Stryker 10.1.1 CLI options (`stryker run --help`). TAP's
coverage selection and attribution are at **file**, not individual `test()`,
granularity. Expanding `--mutate` does not automatically expand the default test
files: select the corresponding files with `--testFiles` too.

Reports overwrite `reports/mutation/index.html` and `reports/mutation/mutation.json`.
Reports, sandboxes, and dependencies are ignored. Concurrency is capped at two;
timeouts allow 3000 ms plus twice baseline runtime. There is no incremental
cache or score threshold, so each invocation computes a fresh baseline.

The sandbox uses `ignorePatterns`, not deprecated `files`. It excludes
`tsconfig.json`: native stripping does not use it, and Stryker's config rewriting
calls a TypeScript 5 compiler API absent in this repository's TypeScript 7.
`run check` remains the separate authoritative typecheck; mutation testing is not
a typechecker. Test runner arguments preserve TAP's preload hook and reporter.

Measured counts, survivor analysis, and limitations:
[`../../docs/research/pi-agent-mutation-baseline.md`](../../docs/research/pi-agent-mutation-baseline.md).
