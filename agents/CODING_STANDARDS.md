# Coding standards

## Events

- Prefer event subscriptions over polling when the system provides them. Use polling when events are unavailable or unreliable.

## React

- When the installed React version and renderer support `useEffectEvent`, prefer it over `useCallback` for callbacks that belong to Effects and need the latest props or state without restarting the Effect.
- Call Effect Events only from Effects or callbacks that those Effects register. Keep reactive inputs in the Effect dependency list. Leave Effect Events out of that list.
- Use regular functions or `useCallback` for UI event handlers and callbacks passed to children. When UI handlers and Effects share logic, keep that logic in a regular function and wrap the Effect path with `useEffectEvent`.

## Commit messages

- Use Conventional Commits.

## Behavioral tests

- Test observable behavior through public interfaces, with expected outcomes specified independently of implementation constants or logic.
- For configurable limits, set explicit values and test below, at, and above each boundary. Use at least two limits to catch ignored configuration. Assert production defaults only when they are explicit product requirements.
- Isolate relevant environment inputs and restore changed variables to their original value or absence.
