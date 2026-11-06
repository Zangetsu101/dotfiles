# opencrvs-core: local setup

This file isn't tracked by the repo. It's a symlink into `~/.dotfiles/opencrvs-core/overlay/`, which `worktree-overlay` creates in every worktree. Edit the file there.

The repo is a bare clone at `/home/tameem/projects/opencrvs-core/.bare`. Checkouts are linked worktrees, either under `/home/tameem/projects/opencrvs-core/` (`core-develop` holds the `mul-local-env` branch, `core-release`, feature dirs) or wherever T3 creates them.

## Local environments

`mul-local-env` runs N environments as host node processes over one shared dependency singleton. Design and the isolation table: `docs/adr/0005-multiple-local-environments.md` (in `/home/tameem/projects/opencrvs-core/core-develop` if this branch lacks it). Vocabulary (environment, name, slot, primary, registry, dependency singleton) is in the `CONTEXT.md` glossary; use those words.

### Bootstrapping a worktree

Two windows, in this order:

```bash
pnpm dev --only-dependencies   # the singleton: brings it up, waits for it, exits
pnpm dev --only-services       # this environment: secrets, slot, provisioning, start
```

`--only-services` is the whole per-environment bootstrap. It waits for the singleton, generates `.secrets` when missing, resolves the slot, prints the ports and provisions the database before starting. It's up when the logs slow and stop; run `seed:dev` only after that.

### Slots in this layout

Every checkout is a _linked_ worktree (`.bare` is the common git dir), so none of them is the primary one. Consequences:

- Slot 0 is reserved for the _default environment_ (the primary worktree without `--env`). It never exists here, so slots run 1–5: **5 concurrent environments, not 6.**
- Every environment therefore gets derived identifiers (`events_<name>`, its own ES prefix and bucket).

Slots follow registration order rather than directory name, so read an environment's ports with `pnpm env:lookup` instead of assuming them.

### Lifecycle

- The dependency singleton is detached and shared (`-p opencrvs-deps`), and starting it is idempotent, so `--only-dependencies` is safe to re-run against a live one. It keeps its data in docker named volumes. Its teardown verb takes `--volumes`, which wipes every environment's data at once, not just the calling one's.
- `pnpm env:list` and `pnpm env:destroy <name>` act on the registry at `~/.local/state/opencrvs/envs.json`.
- `--env <name>` pins the name, and so the slot and database, across renaming or recreating the directory. `db:clear:all`, `seed:dev`, `reindex`, `debug`, `open` and `e2e:dev` act on the _calling_ environment and take it too.
- Not isolated: Node's inspector stays on `9229` for every environment, so `pnpm debug` attaches one environment at a time.

## Shared nx cache

Every worktree's `.nx/cache` is a symlink to `/home/tameem/projects/opencrvs-core/.nx-cache/`, so a target built in one worktree replays in the others. `.nx/workspace-data` stays private to each worktree; it holds the project graph and daemon state.

A new worktree is linked by the `post-checkout` hook. After `nx reset`, which removes the symlink and silently drops that worktree back to a private cache, re-run `~/.dotfiles/opencrvs-core/bin/worktree-overlay`. Its header covers the mechanics.

Hits come between worktrees on the same or nearly the same commit; diverged branches correctly miss. Before calling the cache broken, build a target in one worktree, run it in another, and look for `[local cache]`.

## Running tasks

Run every task via `nx run` (or `lerna run`, an nx front-end) so nx resolves its dependencies, e.g. `nx run @opencrvs/gateway:test`.

## Agent skills

### Scratch folder

`/home/tameem/projects/opencrvs-core/.scratch/` holds local notes, specs and temporary scripts. All worktrees share this folder.

### Domain docs

`CONTEXT.md` and `docs/adr/` at the checkout root, tracked on `develop`. See `docs/agents/domain.md`.
