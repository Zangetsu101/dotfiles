# Coding standards

## Events

- Prefer event subscriptions over polling when the system provides them. Use polling when events are unavailable or unreliable.

## React

- Move render helpers into module-level components with explicit props when they represent a named UI element, such as a chip, row, card, field, or section, especially when they own interaction, conditional rendering, or styling. Keep helpers inline when they only format a value or assemble a small markup fragment.
- Prefer `ReactNode` over `() => ReactNode`. Use render props when the caller needs to supply data to render the content.
- When the installed React version and renderer support `useEffectEvent`, prefer it over `useCallback` for callbacks that belong to Effects and need the latest props or state without restarting the Effect.

## Commit messages

- Use Conventional Commits.

## Behavioral tests

- Test observable behavior through public interfaces, with expected outcomes specified independently of implementation constants or logic.
- For configurable limits, set explicit values and test below, at, and above each boundary. Use at least two limits to catch ignored configuration. Assert production defaults only when they are explicit product requirements.
- Isolate relevant environment inputs and restore changed variables to their original value or absence.
