# Targeted mutation audit

## Scope and method

This audit continues baseline commit `0ba6304` on `feat/pi-agent-mutation` in
`/tmp/dotfiles-stryker-implement`. The running main checkout is unchanged.
The starting JSON report was preserved locally as `/tmp/mutation-before-audit.json`.
It matches the committed baseline: 254 generated, 194 killed, one timeout,
38 survived, 21 uncovered, zero errors, 23.67 seconds wall time.

The requested public seams are the scheduler's schedule/watch/stop operations
with injected time and real temporary files, and the exported family identity,
context and parent-metadata functions. No production code or private filesystem
read order was changed. Existing surviving mutants provide the red evidence;
new tests pass on the original implementation and focused runs check sensitivity.
This is regression-test strengthening, not a claim that new features went through
an initially failing production implementation.

## Test audit

The dedicated family tests exercise identities and restoration through exported
functions. Complete literal identity assertions describe the returned contract,
not its implementation. New context tests use the process environment boundary
and session-manager API to test persisted-family restoration, pane/name forwarding,
session-id precedence, absent methods and cwd fallback. Parent metadata is tested
with distinct root and child identities so accidentally using the root as the
immediate parent cannot pass. The new context test file is included in Stryker's
scope; the existing background-task-family suite does not call these exports and
was not added merely to raise the score.

Scheduler tests mostly observe delivery, deadlines, persistence and suppression
through the public API. Fake timer queues are a supported injected boundary;
asserting cancellation there checks resource behavior independently of callback
suppression. Real files exercise persistence and claims. New error scenarios use
an obstructing directory and corrupt JSON rather than mocking private reads.
Console capture observes the error-reporting boundary. Duplicate claims must be
quiet, while genuine errors must be reported. Rename failure must remove its
staging file and allow a later successful schedule.

There is one existing coupling worth retaining as a limitation: the
`completion during output collection` test returns completion on the second
`completion()` invocation and asserts that count. It tests a desired race outcome,
but its trigger depends on collaborator call order. It was not copied into new
scheduler cases. Exact persisted JSON field assertions and timer delay assertions
also constrain persistence and timer-adapter contracts; they do not prove race
safety or substitute for end-to-end delivery assertions.

TAP attributes coverage to test files, not named cases. This audit makes no claim
that an individual test is useless because its file shares mutant kills with
another file. Overlapping examples can document distinct behavior even when
mutation attribution cannot distinguish them.

## Family survivor classification

All 17 previously uncovered family mutants are now exercised. Context identity
precedence and optional session-manager methods, persisted entries and parent
metadata were real untested contracts, not equivalent code.

Three family mutants remain in the focused run:

- ID 25 changes the absent-branch default from `[]` to `["Stryker was here"]`.
  Both produce no family entry because the scan checks `type === "custom"`.
  This is observationally equivalent for this fallback value.
- ID 63 starts the reverse scan at `length + 1` instead of `length - 1`.
  Ordinary arrays produce two additional undefined reads, skipped by optional
  access. This is redundant for the real dense session arrays, not a claim of
  equivalence for arbitrary proxies or arrays with exotic inherited getters.
- ID 78 removes optional access on `entry.type`. Dense valid session entries
  do not expose this change. Sparse or undefined entries would throw. That is a
  robustness gap for out-of-contract input, not proven global equivalence;
  no sparse-array test was added just to increase the score.

The family focused run generated 110 mutants: 105 killed, two timeouts,
three survived, zero uncovered/errors, 10.58 seconds wall time. The timeouts are
loop-condition/update mutants, not assertion kills. Commands use one quoted
`--testFiles 'tests/background-family*.test.ts'` glob; multiple positional test
paths are not accepted by Stryker's CLI.

## Scheduler findings

Six new scenarios cover rename-failure cleanup/recovery, watch read failures,
corrupted-deadline timer reporting, callback rejection and explicit rearm, claim
permission failures, and completion-marker access failures. The existing
collision test now also rejects spurious error reports. Permission coverage ran
as uid 1000; that case explicitly skips for root. EISDIR/ELOOP fixtures target
this repository's Linux runtime.

The audit also found a genuine fixture defect: directly invoking an early timer
left it in the fake pending queue. Removing early-wakeup rearming therefore
survived even though rearming is required. Queued callbacks now dequeue their
own handle before invocation, as actual timers do. The unchanged early-wakeup
behavioral assertion now kills that mutant. This changes the clock boundary,
not the scheduler's private reads.

Remaining scheduler survivors, grouped by source line and replacement:

| Lines | Surviving changes | Evidence and classification |
| --- | --- | --- |
| 11 | default clearTimer `??` to `&&` | Fixtures inject clearTimer; real default cancellation remains a gap. |
| 26 | UTF-8 encoding to empty string | Buffer coercion preserves parsed JSON on this Node runtime; candidate equivalence, not a formal proof. |
| 38-39, 45, 48 | timer cancellation conditions/calls and timer map removal/insertion | Later identity/callback/claim checks mask duplicate wakeups. Resource cleanup remains unasserted, not globally equivalent. |
| 52, 54 | initial callback/state guards | Later checks mask sequential stop/replacement. Missing-state and concurrent interleavings remain gaps. |
| 64, 66 | identity/callback rechecks and optional access | Replacement/deletion/stop between filesystem awaits is not forced. Potential race safety barriers, not proven redundant globally. |
| 67 | optional access on post-callback read | Deadline deletion during callback remains untested. |
| 68, 79 | force options removed/false during cleanup | Files exist in normal fixtures. Concurrent deletion before removal remains untested. |
| 74 | RangeError diagnostic removed | Type is asserted; exact wording is not required by this audit. |
| 77 | temporary write mode removed | Confidentiality/permissions of persisted deadlines remain unasserted. |
| 82 | arm when unwatched | Callback guard prevents delivery; unnecessary timer work remains unasserted. |

No remaining scheduler survivor is classified as proven globally equivalent.
The new error cases kill missing propagation/reporting and rename cleanup
mutants, while the collision assertion distinguishes expected EEXIST from real
claim failures. The timer fixture repair resolves the previously masked
rearming gap.

Significant remaining behavior: callback rejection logs but retains the claim,
so the same deadline is not retried; explicit scheduling recovers. Permission
errors also log without an automatic retry. These tests document observed
behavior, not a decision that permanent notification loss is desirable.
`watch` registers its callback before a failed read and retains it until stop.
No production retry-policy change was made in this test audit. Cross-process
races, actual timer unref/process lifetime and filesystem confidentiality still
need separate work if those guarantees are required.

## Final validation

The scheduler-focused command was:

```sh
npm --prefix pi/agent run test:mutation -- --mutate extensions/lib/task-check-in.ts --testFiles tests/task-check-in.test.ts
```

It generated 144 mutants, 114 killed, 30 survived, zero uncovered/timeouts/errors,
20.06 seconds wall time. Before the timer fixture repair the same scope had
113 killed and 31 survived. The starting scheduler baseline was 104 killed,
36 survived and four uncovered.

Final combined run: 254 generated, 220 killed, one timeout, 33 survived,
zero uncovered/errors, score 87.01%, 27.28 seconds wall time. Compared with the
baseline this removes all 21 uncovered cases and reduces survivors from 38 to
33. Some newly covered mutants survive; the change is not simply five newly
killed mutants. Family has 106 assertion/runtime kills and one loop timeout in
the combined run; its focused run had 105 kills and two timeouts, so timeout
versus kill attribution varies between runs and is not a behavioral improvement.

Final `npm --prefix pi/agent run check`: 182/182 passed, zero skipped, typecheck
and dependency synchronization passed, exit zero, 4.79 seconds wall time.
The baseline check was 173/173 in 4.90 seconds. These are single local timings,
not benchmarks. Reproduce the combined run with the baseline's default command.
Reports remain at `pi/agent/reports/mutation/mutation.json` and `index.html`,
ignored by Git and overwritten on subsequent runs.

Independent staged Standards and Spec reviews, including the final test
additions, found no code findings. Standards flagged missing final measurements
in the staged document; the final measurements above resolve that documentation
finding. Spec reported no actionable findings. Deslop review found no
unnecessary production changes or private mocks. No mutant exclusions or score
gates were introduced.
