# Family-scoped metadata invalidations

## Routing contract

Known-family writes use `family-<sha256 of UTF-8 family ID>` in the metadata directory. The fixed-length digest avoids path separators and filename-length limits. Creation, creation rollback after allocation, rename, root reconciliation, status updates, and cleanup pass the family ID. Legacy tasks without a family still write `invalidation`.

Directory observation now delivers an optional filename. The task watcher ignores atomic temporary siblings and skips a scoped event when none of its subscriptions needs that family. Initial delivery, safety sweeps, reattachment, errors, missing filenames, and unrecognized filenames remain conservative. A relevant event still scans the tmux server once and filters snapshots for every subscription in that watcher. It does not perform a family-targeted tmux listing.

Subtree queries accept `routingFamilyId`. This hint affects invalidations, not task visibility, and callers must supply the subtree's actual family. The agent, monitor, and status extensions supply it for their own node, including an empty virtual Root Pi. An explicitly configured monitor subtree may belong to another family, so that override does not receive the current Pi's hint. Unhinted subscriptions learn a family from a live root or a task whose `rootId` matches the virtual root, and keep it after removal. A root never observed and without a hint remains conservative until discovery resolves it. IDs must retain their family identity; moving a subtree between families requires a new subscription or corrected hint.

## Generic hooks and recovery

Session creation and family restoration set the reserved session options `@pi_task_invalidation_family` to the original family ID and `@pi_task_invalidation` to its hashed filename. Hooks inherit this option from their target session. Only an exact `family-` prefix followed by 64 lowercase hexadecimal digits may enter the shell command; raw family IDs never enter it. Missing or malformed tokens use the generic invalidation file. Scoped routing also requires the current target's `@pi_task_family_id` to equal the nonempty original family ID. An external family reassignment therefore keeps subsequent mutations generic instead of continuing to signal the old family. The original family is compared within tmux formats, never inserted into shell code.

New-window, split-window, and rename hooks route by this token. New-session hooks remain generic because initial session creation precedes token installation. Targeted `after-set-option` events route only when `hook_flag_t` is present, neither `hook_flag_g` nor `hook_flag_s` is set, and the option is none of `@pi_task_family_id`, `@pi_task_invalidation`, or `@pi_task_invalidation_family`. Identity edits remain generic because changing the family may affect more than the token's original family. Older tmux versions lacking these hook formats fall back conservatively for option edits. No hook adds a tmux query to discover its family.

Destructive hooks remain generic. Last-pane exit, pane deletion, window unlinking, and session closure can expose a surviving session's unrelated options. Untargeted, global, and server option edits also remain generic, even when their normal target formats expose a task session. Unclassified non-task events are not silently dropped. This guarantees zero unrelated calls for reliably scoped events, not for all real monitor creation.

Existing sessions without a token remain conservative until family restoration backfills it or a new session is created. The token and its companion family are reserved internal metadata, not user-configurable family aliases. Restoration clears the token before replacing the companion/token pair, keeping hooks conservative even if an external mutation interleaves with restoration.

The 30-second safety sweep still probes the server PID and reinstalls hooks when it changes, even without metadata events. No PID cache or debounce was added. Events arriving during a running reconcile still queue another reconcile. The existing process-global directory observer survives extension reloads; an already-running observer from the old implementation will omit filenames and remain conservative until the process restarts.

Invalidation files are signals, not task records, and remain on disk after family removal, as the generic invalidation file did. This adds one small file per family over the lifetime of the temporary directory.

## Hook-context probes

Real tmux 3.8 probes used isolated `-f /dev/null` servers with two families. Command hooks generally had empty `hook_session`, `hook_window`, and `hook_pane` fields but usable normal target formats. Targeted session options were inherited by new windows and panes.

| Event | Observed context | Policy |
| --- | --- | --- |
| New session | New target, before session metadata | Generic |
| New window, split, rename | Normal target session retains the token | Scoped when validated |
| Targeted option edit | Normal target and `hook_flag_t` | Scoped except identity edits |
| Global/server option edit with explicit task target | Task token still visible; `hook_flag_g` or `hook_flag_s` set | Generic |
| Untargeted option edit | No `hook_flag_t`; default context may be unrelated | Generic |
| Last-pane kill or exit | Normal formats switch to the surviving family's session | Generic |
| Session closure, window unlink | Hook IDs identify the removed target; normal formats expose the survivor | Generic |
| Retained-pane death | Existing target may survive, but no destructive hook is assumed safe | Generic |

These probes also found no built-in hash format. Shell quoting with `q` removes literal newlines, so raw family IDs are not transported through shell arguments. The reserved digest token avoids both extra hash processes and extra tmux queries.

## Measurement and budgets

Run from `pi/agent`:

```sh
node --experimental-strip-types --test tests/background-task-routing-budget.test.ts
```

The workload uses a fresh tmux server and isolated metadata directory, two separate watcher instances subscribed to different virtual-root subtrees, and two sequential monitors in one family. Setup and hook installation are excluded. Creation and settling are included. Watcher calls include PID probes and listings. The interval clock is held so safety sweeps contribute exactly zero; independent server-recovery tests advance that clock explicitly.

The same workload was copied to a detached worktree at baseline `644263b`, then run against this implementation:

| Calls | Baseline | Scoped metadata |
| --- | ---: | ---: |
| Creator | 66 | 66 |
| Same-family watcher | 45 | 39 |
| Unrelated-family watcher | 39 | 33 |
| Safety sweeps | 0 | 0 |

A full-suite loaded run measured 66 / 42 / 33. Counts vary with filesystem event batching and tmux hook scheduling. After hook routing, the regression ceilings are 100 creator calls, 90 same-family watcher calls, and 30 unrelated-family watcher calls for this workload. These leave scheduling headroom rather than requiring one reconcile per monitor. Initial `after-new-session` runs before the token exists, session token and family-identity writes remain generic, every new task writes its family identity, and bootstrap-window removal fires generic destructive hooks. These account for the remaining creation fallback classes.

Initial hook-routing measurements of the same two-monitor workload observed 67 creator calls, 33–39 same-family watcher calls, and 15–21 unrelated-family watcher calls. After review added a companion-family guard against external reassignment, the workload measured 68 / 39 / 15, and 68 / 42 / 21 in a passing parallel full-suite run. The two extra creator calls install the routing identity and token. A full-suite run concurrent with mutation testing observed 67 / 33 / 15; its hook tests passed, but two unrelated 10-second integration deadlines expired under load, so it was not a passing full-suite validation.

Final validation passed serially: all 308 tests, plus `tsc --noEmit` and the dependency-sync check. A parallel `npm run check` passed all 307 tests before the final restoration-race regression was added. Other parallel attempts encountered 10-second integration deadline cancellations or a tmux server-restart race; the affected tests passed in isolation and in the final serial suite. Serial validation command:

```sh
./node_modules/.bin/tsc --noEmit && node scripts/sync-pi-dependencies.mjs --check && node --experimental-strip-types --test --test-concurrency=1 --test-reporter=spec tests/**/*.test.ts
```

The hook-routing tests exercise public watcher snapshots and adapter call counts on isolated real servers, including targeted and untargeted renames, generic option fallbacks, malformed tokens, restored families, and destructive events.

A separate deterministic fake-tmux workload creates a monitor, sets its terminal status, and cleans it up without hook events. An unrelated empty-root subtree watcher made 27 calls before routing and zero after routing. That zero-call requirement is asserted, including the filesystem events from atomic temporary files. Other tests cover unhinted unknown roots, learned routing after removal, mixed subscriptions, missing filenames, in-flight invalidations, external tmux edits, and server replacement with and without metadata events.

For hook routing, a focused Stryker run first covered `background-task-watcher.ts:73:0-90:0` and killed 22 of 27 mutants. Two survivors concerned unchanged generation/installation guards outside the new routing behavior. Removing an unnecessary new-session routing branch eliminated another. One meaningful survivor exposed missing coverage for untargeted rename hooks; a new public-seam test closes that gap. The second run at `78:0-90:0` killed 18 of 19 mutants with no timeouts. The only survivor replaces the default false format string `"0"` with `""`, which is equivalent in tmux. After the spec-review fix, a focused run at `74:0-76:0` killed both mutants in the companion-family routing guard. Token installation/backfill producers were covered by ordinary tests, including a deterministic interleaving during restoration, but not mutation-tested.

A focused Stryker run for the earlier metadata routing change used the existing TAP runner with `tests/background-task-watcher.test.ts` and mutation range `extensions/lib/background-task-watcher.ts:92:0-99:0`, excluding regex mutations. Two initial survivors exposed missing tests for mixed subscriptions and family-only isolation. After adding those tests, the rerun reported 15 killed, 2 timed out, and zero survivors. This run covers the scoped-event routing decision, not all mutation producers, filename regex variants, or learned-family discovery.
