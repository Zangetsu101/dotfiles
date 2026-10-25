# Pi agent mutation baseline

## Reproduce

From the repository root:

```sh
npm --prefix pi/agent ci
npm --prefix pi/agent run check
/usr/bin/time -p npm --prefix pi/agent run test:mutation
```

See [the agent README](../../pi/agent/README.md) for focused CLI runs, runtime
requirements, report paths, and the TypeScript 7 sandbox workaround. Core and
TAP runner are pinned to StrykerJS 10.1.1 in the agent lockfile. Measurements used
Node 22.19.0, npm 10.9.3, concurrency 2, native type stripping, no checker or
incremental cache. Times are individual local wall-clock measurements, not
benchmarks. Production extension sources are unchanged.

The prior evaluation is `/tmp/dotfiles-stryker-eval/docs/research/stryker-node-test.md`.
Its strengthened 14-case scheduler suite was ported; this integration adds four
scheduler cases and improves the deterministic family identity suite from three
to six cases. Neither the temporary evaluation nor its pilot installation is
needed to reproduce this baseline.

## Measurements

Initial integration, after porting scheduler tests but before survivor-driven
additions: 254 generated mutants, 148 killed, 81 survived, 25 no coverage, zero
timeouts/errors; total score 58.27%, 21.46 s wall time.

Final default scope (two modules, two dedicated test files):

| Module | Generated | Killed | Timeout | Survived | No coverage | Errors | Total score |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| task-check-in.ts | 144 | 104 | 0 | 36 | 4 | 0 | 72.22% |
| background-family.ts | 110 | 90 | 1 | 2 | 17 | 0 | 82.73% |
| Total | 254 | 194 | 1 | 38 | 21 | 0 | 76.77% |

Final wall time: **23.67 s** (user 63.06 s, sys 12.38 s). Covered score: 83.69%.
Stryker includes timeouts in detected mutants; the one timeout is the family
entry scan mutated from `index--` to `index++`, producing an unbounded loop when
trailing unrelated entries must be skipped. It is not an assertion kill.

A real focused scheduler run using the documented `--mutate` and `--testFiles`
options reproduced 104 killed / 36 survived / 4 no coverage, zero errors or
timeouts, 16 seconds as reported by Stryker. No test-name selection is claimed.

Final `npm --prefix pi/agent run check`: **173/173 passed**, zero skipped,
TypeScript and dependency synchronization passed, exit 0, **4.90 s** wall time.
Mutation testing remains opt-in; no ordinary check or hook invokes it.

## Survivor review and justified tests

The red evidence here is real surviving mutants, rather than deliberately
breaking production. Tests passed against the unchanged implementation and the
next mutation run killed the corresponding behavioral deviations.

- Scheduler: restored data must have a string id and numeric deadline. Invalid
  JSON must reject rather than silently dropping a deadline. New tests cover
  invalid persisted shapes and corrupt JSON through `watch`.
- Scheduler: completion during a suppressed callback must prevent retry, and a
  replacement scheduled during suppression must retain its own deadline. Tests
  use the existing public scheduler and injected clock with real temporary
  files; no filesystem call-order mocks or forced internal races were added.
- Family identity: assert the complete child identity, root identity, and new
  family id, not only a subset of fields. Exercise missing optional child
  environment fields, named-session fallbacks, latest-entry precedence,
  unrelated/malformed entries, and truthy non-string persisted identities.
  The latter catches incorrectly accepting a numeric root id.

Remaining scheduler survivors include timer cancellation/resource cleanup,
error reporting, claim collision errors, filesystem permissions, and repeated
identity checks around asynchronous filesystem operations. Several checks are
redundant in deterministic sequential scenarios, but that does not prove global
equivalence under concurrent processes. The timer wrapper catches errors and
logs them: mutants that turn a successful duplicate claim into a logged failure
can survive callback-count assertions. Rename-failure cleanup and the catch
message have no coverage. Do not interpret the score as filesystem fault or
race coverage; those paths need separate fault scenarios rather than tests
coupled to the number/order of private reads. No production race internals were
exposed to improve the score.

The two remaining family survivors are starting the reverse scan beyond the
array end (the optional access skips the extra absent entries) and removing
optional access for a sparse entry. Dense valid session entries do not expose
the latter. Seventeen no-coverage mutants are in `familyTaskParent` and
`familyForContext`, outside the focused pure `familyForSession` scenarios;
the whole module remains in the denominator rather than excluding these lines.

## Limits and operational notes

- TAP measures and selects test **files**, not individual named Node cases.
  Its coverage report is not a named-test assertion matrix. Runtime exceptions
  also count as kills, and TAP cannot detect static mutants reliably.
- The default scope deliberately does not launch tmux or mutate the full
  background-task runtime. The ordinary full check still exercises its tests.
- Type stripping is not typechecking. Omitting tsconfig from the sandbox avoids
  Stryker calling `parseConfigFileTextToJson`, absent from TypeScript 7's API;
  `check` retains the real tsconfig and typecheck.
- HTML/JSON reports and sandboxes are ignored and overwritten, not committed.
  Use the generated report for exact replacement locations on a fresh run.
- Installation/audit reported five vulnerabilities (three moderate, two high).
  The new Stryker tree includes `typed-rest-client -> qs` and shares `zod` via
  `mutation-server-protocol`; existing Pi SDK dependencies also use `zod` and
  `undici`. No unrelated SDK upgrade or automatic audit fix was applied.
- There is intentionally no score gate, mutation suppression, excluded mutant
  operator, deprecated `files` option, or production change to inflate results.
