# Evidence

The user asks for evidence that the change works, shown as a before and after pair. Collect the before half before you edit any code, because the edit removes the old behavior.

Use the highest tier that the change and the environment allow:

1. **Visual:** screenshots or a recording of each affected screen, viewport and state. Use this tier when the change alters what a user sees.
2. **Execution:** a run that shows the behavior. For example, a test that fails before and passes after, or command output.
3. **Checks only:** typecheck and test suite results. This tier shows that nothing broke. It does not show that the change works.

Save the evidence to files. Show it in your final reply, and keep it for the PR body. If you use a lower tier than the change calls for, say why.
