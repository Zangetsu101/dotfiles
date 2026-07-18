@~/.agents/AGENT.md

## Model selection (subagents & workflows)

| Rung   | Use for                                                              | How                                                                 |
| ------ | -------------------------------------------------------------------- | ----------------- |
| sonnet | mechanical: grep sweeps, listing, extraction, lint, transforms       | `model: 'sonnet'` |
| opus   | implementation, code reading, standard research, **anything unsure** | `model: 'opus'`   |
| top    | judge, adversarial verify, synthesis, architecture                   | omit `model`      |

- `high` = effort ceiling.

## Agent worktrees

Agent-tool worktrees (`isolation: worktree`) branch from the **session-start snapshot**, not current HEAD — commits landed mid-session are invisible to later agents.
  1. Work touching shared or recently-changed files → create worktree manually with explicit base, point agent at it: `git worktree add -b <branch> <path> main`. Prompt must say: "work only in <path>, commit when done."
  2. Independent leaf work (new files only) → agent worktrees fine regardless of base.
  3. Every agent prompt ends with a commit instruction — uncommitted work = empty branch, merges as no-op.
  4. After merging an agent branch: run build + tests, `git worktree remove`, delete branch.
  5. Overlap on shared files is fine — declare the seam in both prompts (one owns, other keeps changes minimal + marked); orchestrator resolves the merge. Never two agents rewriting the same region — sequence that.

@RTK.md
