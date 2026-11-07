---
name: suspense-screen-design
description: Design or refactor React screens around Suspense and error boundaries. Use when planning loading skeletons, error fallbacks and retry, transitions that keep previous content visible, or a move to useSuspenseQuery.
---

Design boundaries around data dependencies and around what must load, reveal, or fail together. Start with the default behavior of React and the data library. Add custom coordination only for an agreed product requirement.

**Custom coordination** is code that manages loading or error state by hand: an effect, a status observer, a copied data snapshot, a loading flag, or a custom error boundary.

## Design process

### 1. Map dependencies and state

Map each visible region to its data reads. Identify prerequisite reads, independent reads, and the scope of each result. A scope is the input that selects the data, such as a selected item, a date, or a filter.

When you refactor a screen, list its current custom coordination. Step 4 checks each item on that list.

Put shared state in the nearest common owner of its consumers. When initial state depends on fetched data, read that data under its own boundary first. Then mount the state owner below that boundary, and set the state with a `useState` initializer.

Finish when every region has a data source, every shared value has an owner, and all existing custom coordination is on the list.

### 2. Choose reveal groups and failure groups

Group regions that must show a consistent snapshot under one boundary. Use sibling boundaries when the regions can load and recover independently. Nest a boundary only for a real data dependency.

Start independent reads at the same time. Two `useSuspenseQuery` calls in one component run one after the other, because the first call suspends before the second call starts. Use `useSuspenseQueries` or a prefetch for parallel reads.

Put each suspending reader below the boundary that handles its pending state. A boundary catches only the components below it. A fallback replaces everything inside its boundary. Put a control or region inside a boundary only when it waits for the reads of that boundary. For example, an item picker that already has its options goes above the boundary for the item's details. Then the picker stays mounted and keeps its local state through loading, errors, and retry.

Use separate components for ready content, skeletons, and error fallbacks. Compose larger fallbacks from the same layout pieces. Make each fallback the same size as its ready content, and follow the reduced-motion setting.

Finish when each reader has a boundary, and each boundary has a defined reveal group and fallback area.

### 3. Define updates and recovery

For each boundary, decide:

| Situation | Decision |
| --- | --- |
| First read | Which skeleton appears? Which controls stay usable? |
| Cached refresh | Does the cached content stay usable? Where does the refresh feedback show? |
| Scope change | Show the fallback, or keep the previous content while the new scope loads? |
| Failure | Which error fallback replaces which area? Does a failed refresh keep the cached data? |
| Retry | Which failed read retries? Which boundary clears its error? |

To keep the previous content visible during a scope change, pass the scope through `useDeferredValue` or change it in `startTransition`. Compare the current value with the deferred value to find out that the visible content is stale. Make the stale status clear, and disable actions that would act on the old scope. Keep labels and links tied to the displayed data. Keeping the previous content after an error is a separate requirement.

An error boundary shows its fallback until it resets or remounts. A change of props does not clear it. To clear it when the scope changes, choose one method:

- A React `key` made from the scope remounts the boundary and its full subtree.
- `resetKeys` from `react-error-boundary` clears the error and keeps healthy children mounted.

Resolve missing product decisions with the user before you add custom coordination. Use the `prototype` skill when the choice is visual.

Finish when each boundary has an answer for each row of the table, and the user agrees to each product decision.

### 4. Show the design

Draw the component tree. Annotate each boundary with its suspending reads, pending fallback, error fallback, retry target, and reset conditions. Show the state owners and the controls outside the boundaries. List each item of custom coordination with the requirement that it serves.

Finish when the user agrees to the tree, and each item of custom coordination names an agreed requirement. Mark the other items for removal.

### 5. Verify the implementation

Test first load, failure and retry, a scope change during a pending read, a return to a failed scope, and a failed cached refresh. Check that independent controls stay mounted, and that late results keep their original scope.

Finish when each case passes, and the implementation has no custom coordination other than the items from step 4.

## Query libraries

Check the Suspense and error contract of the installed library before you add manual fetching or reset logic. The examples here use TanStack Query.

- A change of query key selects a different cache entry. The cache policy decides whether it fetches. A normal scope change needs no reset or refetch call.
- `useSuspenseQuery` suspends or throws only when it has no data. With cached data, it returns that data during a refresh and after a failed refresh. Use its `isFetching` and `error` for refresh feedback.
- Connect refresh triggers in the data layer, such as invalidation after a write or the app focus event. Then screens need no effects to refresh their data.

Keep three operations separate:

1. Clear the error boundary, so that its children render again.
2. Call `reset()` from `QueryErrorResetBoundary`, so that the failed query can fetch again. After a Suspense query fails, TanStack Query turns off `retryOnMount` for it until `reset()` runs. Thus a return to a failed scope also needs this reset.
3. Reset cached data with `resetQueries`. Do this only for an explicit requirement.

Connect the `onReset` of the error boundary to the `reset()` from `QueryErrorResetBoundary`. Keep each retry local to its data owner. A shared retry control belongs in the common owner of the reads that it recovers.
