# Pi agent checks

```sh
npm --prefix pi/agent run check
npm --prefix pi/agent run test:mutation
```

Mutation testing is opt-in and separate from ordinary checks.

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
