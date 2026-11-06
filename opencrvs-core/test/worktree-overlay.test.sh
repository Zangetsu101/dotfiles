#!/usr/bin/env bash
# Tests bin/worktree-overlay against a throwaway repo + linked worktrees.
#   opencrvs-core/test/worktree-overlay.test.sh
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT="$HERE/../bin/worktree-overlay"
fails=0

# Isolate from the user's git config (a global core.hooksPath would disable the hook).
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
unset GIT_DIR GIT_WORK_TREE

ok()   { echo "ok   $1"; }
fail() { echo "FAIL $1"; fails=$((fails + 1)); }
check() { local name=$1; shift; if "$@"; then ok "$name"; else fail "$name"; fi; }

setup() {
  T=$(mktemp -d)
  export WORKTREE_OVERLAY_DIR="$T/overlay"
  mkdir -p "$T/overlay/.claude/hooks"
  echo "local instructions" >"$T/overlay/CLAUDE.local.md"
  echo "#!/bin/sh" >"$T/overlay/.claude/hooks/guard.sh"

  local seed="$T/seed"
  git init -q -b develop "$seed"
  echo '{}' >"$seed/nx.json"
  printf '.claude/*\n!.claude/hooks/\n.nx\n' >"$seed/.gitignore"
  git -C "$seed" add -A && git -C "$seed" -c user.name=t -c user.email=t@t commit -qm seed
  # The main worktree holds the git dir. Linked worktrees are next to it.
  git clone -q "$seed" "$T/root/main"
  git -C "$T/root/main" switch -q --detach
  git -C "$T/root/main" worktree add -q "$T/root/a" develop 2>/dev/null
  (cd "$T/root/a" && "$SCRIPT" >/dev/null)   # sweep: installs the hook
}
teardown() { rm -rf "$T"; unset WORKTREE_OVERLAY_DIR; }
link_of() { readlink "$1" 2>/dev/null; }

# --- sweep links an existing worktree
setup
check "sweep links overlay file" [ "$(link_of "$T/root/a/CLAUDE.local.md")" = "$T/overlay/CLAUDE.local.md" ]
check "sweep links nested overlay file" [ "$(link_of "$T/root/a/.claude/hooks/guard.sh")" = "$T/overlay/.claude/hooks/guard.sh" ]
check "sweep links nx cache" [ "$(link_of "$T/root/a/.nx/cache")" = "$T/root/.nx-cache" ]
check "sweep links the main worktree" [ "$(link_of "$T/root/main/CLAUDE.local.md")" = "$T/overlay/CLAUDE.local.md" ]
check "excluded: main worktree status clean" [ -z "$(git -C "$T/root/main" status --porcelain)" ]
check "nothing linked into the root" [ ! -e "$T/root/CLAUDE.local.md" ]
check "excluded: worktree status clean" [ -z "$(git -C "$T/root/a" status --porcelain)" ]
check "hook installed" [ -L "$T/root/main/.git/hooks/post-checkout" ]
check "sweep is idempotent and quiet" [ -z "$(cd "$T/root/a" && "$SCRIPT" --quiet)" ]
check "one managed exclude block after reruns" [ "$(grep -c '>>> worktree-overlay' "$T/root/main/.git/info/exclude")" = 1 ]
teardown

# --- a branch without nx.json gets the overlay but no cache link
setup
git -C "$T/root/a" switch -q -c no-nx && git -C "$T/root/a" rm -q nx.json
git -C "$T/root/a" -c user.name=t -c user.email=t@t commit -qm no-nx
git -C "$T/root/a" switch -q develop
git -C "$T/root/a" worktree add -q "$T/root/old" no-nx 2>/dev/null
check "no-nx worktree gets overlay" [ -L "$T/root/old/CLAUDE.local.md" ]
check "no-nx worktree gets no cache link" [ ! -e "$T/root/old/.nx" ]
teardown

# --- git worktree add anywhere triggers the hook
setup
git -C "$T/root/a" worktree add -q -b feat "$T/elsewhere/feat" 2>/dev/null
check "new worktree outside root gets overlay" [ "$(link_of "$T/elsewhere/feat/CLAUDE.local.md")" = "$T/overlay/CLAUDE.local.md" ]
check "new worktree outside root gets nx cache" [ "$(link_of "$T/elsewhere/feat/.nx/cache")" = "$T/root/.nx-cache" ]
check "new worktree status clean" [ -z "$(git -C "$T/elsewhere/feat" status --porcelain)" ]
teardown

# --- never clobbers a real file
setup
git -C "$T/root/a" worktree add -q -b b "$T/root/b" 2>/dev/null
rm "$T/root/b/CLAUDE.local.md"; echo mine >"$T/root/b/CLAUDE.local.md"
out=$(cd "$T/root/a" && "$SCRIPT" 2>&1)
check "real file kept" [ "$(cat "$T/root/b/CLAUDE.local.md")" = mine ]
check "real file warned about" grep -q "b/CLAUDE.local.md" <<<"$out"
rm "$T/root/b/.claude/hooks/guard.sh" "$T/root/b/.nx/cache"
(cd "$T/root/a" && "$SCRIPT" >/dev/null 2>&1)
check "conflict does not stop other overlay files" [ -L "$T/root/b/.claude/hooks/guard.sh" ]
check "conflict does not stop the cache link" [ -L "$T/root/b/.nx/cache" ]
teardown

# --- prunes links whose overlay source is gone
setup
rm "$T/overlay/.claude/hooks/guard.sh"
(cd "$T/root/a" && "$SCRIPT" >/dev/null)
check "stale link pruned" [ ! -L "$T/root/a/.claude/hooks/guard.sh" ]
check "stale exclude dropped" bash -c '! grep -q guard.sh "$1"' _ "$T/root/main/.git/info/exclude"
teardown

# --- merges a private nx cache into the shared one
setup
git -C "$T/root/a" worktree add -q -b c "$T/root/c" 2>/dev/null
rm "$T/root/c/.nx/cache"; mkdir -p "$T/root/c/.nx/cache/123"; echo x >"$T/root/c/.nx/cache/123/f"
(cd "$T/root/a" && "$SCRIPT" >/dev/null)
check "private cache merged" [ -f "$T/root/.nx-cache/123/f" ]
check "private cache replaced by link" [ -L "$T/root/c/.nx/cache" ]
teardown

[ "$fails" -eq 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
