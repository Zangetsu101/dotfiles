#!/usr/bin/env bash
# PreToolUse(Bash): block `npx <repo tool>` and say what to run instead. In a
# worktree without node_modules, npx downloads whatever version is latest.
cmd=$(jq -r '.tool_input.command // ""')
tools='prettier|eslint|tsc|vite|vitest|storybook|knip'
# npx where a command starts (line start, after ; & | ( or $( and any VAR=value
# prefixes), so a quoted mention in a message or a grep pattern is left alone.
tool=$(grep -oE "(^|[;&|(])[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*npx[[:space:]]+(-[^[:space:]]+[[:space:]]+)*($tools)([[:space:]);&|]|$)" <<<"$cmd" |
  grep -oE "($tools)[[:space:]);&|]*$" | tr -d ' \t);&|' | head -1)
[ -z "$tool" ] && exit 0
jq -n --arg tool "$tool" '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny",
  permissionDecisionReason: "Use `pnpm exec \($tool)` instead of `npx \($tool)`: npx downloads the latest version when the worktree has no node_modules. If pnpm exec cannot find it, run `pnpm install` first. knip is not a dependency: use `pnpm knip:compare`."}}'
