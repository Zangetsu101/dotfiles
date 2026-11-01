# Family-scoped metadata invalidations

## Routing contract

Known-family writes use `family-<sha256 of UTF-8 family ID>` in the metadata directory. The fixed-length digest avoids path separators and filename-length limits. Creation, creation rollback after allocation, rename, root reconciliation, status updates, and cleanup pass the family ID. Legacy tasks without a family still write `invalidation`.

Directory observation now delivers an optional filename. The task watcher ignores atomic temporary siblings and skips a scoped event when none of its subscriptions needs that family. Initial delivery, safety sweeps, reattachment, errors, missing filenames, and unrecognized filenames remain conservative. A relevant event still scans the tmux server once and filters snapshots for every subscription in that watcher. It does not perform a family-targeted tmux listing.

Subtree queries accept `routingFamilyId`. This hint affects invalidations, not task visibility, and callers must supply the subtree's actual family. The agent, monitor, and status extensions supply it for their own node, including an empty virtual Root Pi. An explicitly configured monitor subtree may belong to another family, so that override does not receive the current Pi's hint. Unhinted subscriptions learn a family from a live root or a task whose `rootId` matches the virtual root, and keep it after removal. A root never observed and without a hint remains conservative until discovery resolves it. IDs must retain their family identity; moving a subtree between families requires a new subscription or corrected hint.

## Generic hooks and recovery

All existing tmux hooks remain generic. No hook is assumed to provide a reliable family before task options exist or after its target disappears. In particular, `after-set-option` during creation can still wake unrelated Pis. External option edits and target deletion therefore remain observable. This change guarantees zero calls for an unrelated *known-family metadata event*, not zero calls for real monitor creation.

The 30-second safety sweep still probes the server PID and reinstalls hooks when it changes, even without metadata events. No PID cache or debounce was added. Events arriving during a running reconcile still queue another reconcile. The existing process-global directory observer survives extension reloads; an already-running observer from the old implementation will omit filenames and remain conservative until the process restarts.

Invalidation files are signals, not task records, and remain on disk after family removal, as the generic invalidation file did. This adds one small file per family over the lifetime of the temporary directory.

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

A full-suite loaded run measured 66 / 42 / 33. Counts vary with filesystem event batching and tmux hook scheduling. The regression ceilings are 100 creator calls and 180 calls per watcher for this workload, leaving scheduling headroom rather than requiring one reconcile per monitor. Generic-hook fallback remains the dominant cost, so this is a modest real-creation reduction, not complete isolation.

A separate deterministic fake-tmux workload creates a monitor, sets its terminal status, and cleans it up without hook events. An unrelated empty-root subtree watcher made 27 calls before routing and zero after routing. That zero-call requirement is asserted, including the filesystem events from atomic temporary files. Other tests cover unhinted unknown roots, learned routing after removal, mixed subscriptions, missing filenames, in-flight invalidations, external tmux edits, and server replacement with and without metadata events.

A focused Stryker run used the existing TAP runner with `tests/background-task-watcher.test.ts` and mutation range `extensions/lib/background-task-watcher.ts:92:0-99:0`, excluding regex mutations. Two initial survivors exposed missing tests for mixed subscriptions and family-only isolation. After adding those tests, the rerun reported 15 killed, 2 timed out, and zero survivors. This run covers the scoped-event routing decision, not all mutation producers, filename regex variants, or learned-family discovery.
