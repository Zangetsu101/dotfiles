# Coding standards

## Events

- Prefer event subscriptions over polling when the system provides them. Use polling when events are unavailable or unreliable.

## Performance

- Run independent async operations concurrently. Use `Promise.all` when all must succeed, or `Promise.allSettled` when every outcome is needed.

## React

- Move render helpers into module-level components with explicit props when they represent a named UI element, such as a chip, row, card, field, or section, especially when they own interaction, conditional rendering, or styling. Keep helpers inline when they only format a value or assemble a small markup fragment.
- Prefer `ReactNode` over `() => ReactNode`. Use render props when the caller needs to supply data to render the content.
- When the installed React version and renderer support `useEffectEvent`, prefer it over `useCallback` for callbacks that belong to Effects and need the latest props or state without restarting the Effect.
- Keep each piece of state in the component that owns it. To reset the state of a child, give the child a new `key`, or lift the state into the parent and pass it down. A counter that a parent increments to make a child reset its state shows that the state has the wrong owner.
- When a component joins independent parts, or uses boolean or mode props to show or hide parts, make it a compound component or accept the parts as `children`. Each caller then composes only the parts that it needs.
- When the installed React version supports Suspense for data, read data in a way that suspends, under a Suspense boundary and an error boundary. Use the Suspense API of the data library when it has one, such as `useSuspenseQuery` in TanStack Query. Otherwise, pass a cached promise to `use`. Let the boundaries handle loading and errors, and keep the component free of its own checks on loading and error state. Use the `suspense-screen-design` skill to place the boundaries.
- Run an async UI mutation in a transition, with `useTransition` or a form action, and use its pending state to disable the controls. A transition replaces hand-written pending flags and refs that block repeat calls.
- To show the result of a mutation before it completes, apply `useOptimistic` to the data that the UI already renders, such as the list of people. Render the optimistic data with the same code as the confirmed data, so children receive the same props for pending and confirmed items.

## Commit messages

- Use Conventional Commits.

## Behavioral tests

- Test observable behavior through public interfaces, with expected outcomes specified independently of implementation constants or logic.
- For configurable limits, set explicit values and test below, at, and above each boundary. Use at least two limits to catch ignored configuration. Assert production defaults only when they are explicit product requirements.
- Isolate relevant environment inputs and restore changed variables to their original value or absence.

## GitHub Actions

- Use the latest stable release or tag for every added or updated GitHub Action. Verify each version against upstream rather than relying on memory.
