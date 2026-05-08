#!/bin/bash

queue_file="/tmp/claude-prettier-${CLAUDE_SESSION_ID:-default}.txt"

[ -f "$queue_file" ] || exit 0

mapfile -t files < <(sort -u "$queue_file")
rm -f "$queue_file"

[ ${#files[@]} -eq 0 ] && exit 0

project_dir="${CLAUDE_PROJECT_DIR:-.}"

if [ -f "$project_dir/node_modules/.bin/prettier" ]; then
  prettier_bin="$project_dir/node_modules/.bin/prettier"
elif command -v prettier &>/dev/null; then
  prettier_bin="prettier"
else
  prettier_bin="npx prettier"
fi

for file_path in "${files[@]}"; do
  [ -f "$file_path" ] || continue
  output=$($prettier_bin --write "$file_path" 2>&1)
  exit_code=$?
  if [ $exit_code -ne 0 ]; then
    echo "prettier failed on $file_path: $output" >&2
  fi
done

exit 0
