#!/usr/bin/env bash
# Blocks Claude from reading .env* files

input=$(cat)
file_path=$(echo "$input" | jq -r '.tool_input.file_path // .tool_input.path // empty')

if [[ "$file_path" =~ (^|/).env ]]; then
  echo "Blocked: reading .env* files is not allowed" >&2
  exit 2
fi
