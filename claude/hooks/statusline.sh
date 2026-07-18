#!/bin/bash
# Claude Code status line: model, context usage, and rate limits.

INPUT=$(cat)

# Currently selected model
MODEL=$(printf '%s' "$INPUT" | jq -r '.model.display_name // .model.id // empty' 2>/dev/null | tr -d '\000-\037')
[ -n "$MODEL" ] && printf ' \033[38;5;141m%s\033[0m' "$MODEL"

# Context window and session usage
USED_PCT=$(printf '%s' "$INPUT" | jq -r '.context_window.used_percentage // empty' 2>/dev/null)
TOTAL=$(printf '%s' "$INPUT" | jq -r '.context_window.context_window_size // empty' 2>/dev/null)
USED_TOK=$(printf '%s' "$INPUT" | jq -r '.context_window.total_input_tokens // empty' 2>/dev/null)
FIVE_HR=$(printf '%s' "$INPUT" | jq -r '.rate_limits.five_hour.used_percentage // empty' 2>/dev/null)
SEVEN_DAY=$(printf '%s' "$INPUT" | jq -r '.rate_limits.seven_day.used_percentage // empty' 2>/dev/null)

if [ -n "$USED_PCT" ] && [ -n "$TOTAL" ] && [ -n "$USED_TOK" ]; then
  TOTAL_K=$(awk "BEGIN { printf \"%.0fk\", $TOTAL/1000 }")
  USED_K=$(awk "BEGIN { printf \"%.0fk\", $USED_TOK/1000 }")
  PCT_INT=$(printf '%.0f' "$USED_PCT")
  # Color: green <50%, yellow 50-80%, red >80%
  if [ "$PCT_INT" -ge 80 ]; then
    CTX_COLOR='\033[0;31m'
  elif [ "$PCT_INT" -ge 50 ]; then
    CTX_COLOR='\033[0;33m'
  else
    CTX_COLOR='\033[0;32m'
  fi
  printf " ${CTX_COLOR}ctx:%s/%s(%s%%)\033[0m" "$USED_K" "$TOTAL_K" "$PCT_INT"
fi

RATE_OUT=""
if [ -n "$FIVE_HR" ]; then
  RATE_OUT="5h:$(printf '%.0f' "$FIVE_HR")%"
fi
if [ -n "$SEVEN_DAY" ]; then
  [ -n "$RATE_OUT" ] && RATE_OUT="$RATE_OUT "
  RATE_OUT="${RATE_OUT}7d:$(printf '%.0f' "$SEVEN_DAY")%"
fi

FIVE_HR_RESET=$(printf '%s' "$INPUT" | jq -r '.rate_limits.five_hour.resets_at // empty' 2>/dev/null)
NOW=$(date +%s)

if [ -n "$FIVE_HR_RESET" ] && [ "$FIVE_HR_RESET" -gt "$NOW" ] 2>/dev/null; then
  SECS_LEFT=$(( FIVE_HR_RESET - NOW ))
  H=$(( SECS_LEFT / 3600 ))
  M=$(( (SECS_LEFT % 3600) / 60 ))
  if [ "$H" -gt 0 ]; then
    TIME_LEFT="${H}h${M}m"
  else
    TIME_LEFT="${M}m"
  fi
  [ -n "$RATE_OUT" ] && RATE_OUT="$RATE_OUT "
  RATE_OUT="${RATE_OUT}(${TIME_LEFT})"
fi
[ -n "$RATE_OUT" ] && printf ' \033[0;36m[%s]\033[0m' "$RATE_OUT"
