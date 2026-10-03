# Coding standards

## Behavioral tests

- Test observable behavior through public interfaces, with expected outcomes specified independently of implementation constants or logic.
- For configurable limits, set explicit values and test below, at, and above each boundary. Use at least two limits to catch ignored configuration. Assert production defaults only when they are explicit product requirements.
- Isolate relevant environment inputs and restore changed variables to their original value or absence.
