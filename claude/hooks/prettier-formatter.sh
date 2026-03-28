#!/bin/bash

input=$(cat)
file_path=$(echo "$input" | jq -r '.tool_input.file_path')

# Skip if no file path
[ -z "$file_path" ] || [ "$file_path" = "null" ] && exit 0

# Only format supported file types
echo "$file_path" | grep -qE '\.(js|jsx|ts|tsx|json|css|scss|html|md|yaml|yml)$' || exit 0

project_dir="${CLAUDE_PROJECT_DIR:-.}"

# Resolve prettier binary: local → global → npx
if [ -f "$project_dir/node_modules/.bin/prettier" ]; then
  prettier_bin="$project_dir/node_modules/.bin/prettier"
elif command -v prettier &>/dev/null; then
  prettier_bin="prettier"
else
  prettier_bin="npx prettier"
fi

# Run prettier, surface errors
output=$($prettier_bin --write "$file_path" 2>&1)
exit_code=$?

if [ $exit_code -ne 0 ]; then
  echo "prettier failed on $file_path: $output"
  exit $exit_code
fi

exit 0
