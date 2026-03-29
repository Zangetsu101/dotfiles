#!/usr/bin/env bash
# Blocks Claude from reading .env* files
#
# Disclaimer: this hook prevents reading .env* files via Read/Grep tool calls,
# but does not prevent users from providing the file contents via context e.g.
# pasting the contents directly into the chat or using "@.env.production".

input=$(cat)
file_path=$(echo "$input" | jq -r '.tool_input.file_path // .tool_input.path // empty')

if [[ "$file_path" =~ (^|/).env ]]; then
  echo "Blocked: reading .env* files is not allowed" >&2
  exit 2
fi
