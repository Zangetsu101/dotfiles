#!/bin/bash
# caveman — statusline badge script for Claude Code
# Reads the caveman mode flag file and outputs a colored badge.
#
# Usage in ~/.claude/settings.json:
#   "statusLine": { "type": "command", "command": "bash /path/to/caveman-statusline.sh" }
#
# Plugin users: Claude will offer to set this up on first session.
# Standalone users: install.sh wires this automatically.

# Read stdin first (must be before any early exits that would discard it)
INPUT=$(cat)

FLAG="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.caveman-active"

# Refuse symlinks — a local attacker could point the flag at ~/.ssh/id_rsa and
# have the statusline render its bytes (including ANSI escape sequences) to
# the terminal every keystroke.
if [ ! -L "$FLAG" ] && [ -f "$FLAG" ]; then
  # Hard-cap the read at 64 bytes and strip anything outside [a-z0-9-] — blocks
  # terminal-escape injection and OSC hyperlink spoofing via the flag contents.
  MODE=$(head -c 64 "$FLAG" 2>/dev/null | tr -d '\n\r' | tr '[:upper:]' '[:lower:]')
  MODE=$(printf '%s' "$MODE" | tr -cd 'a-z0-9-')

  # Whitelist. Anything else → render nothing rather than echo attacker bytes.
  case "$MODE" in
    off|lite|full|ultra|wenyan-lite|wenyan|wenyan-full|wenyan-ultra|commit|review|compress)
      if [ -z "$MODE" ] || [ "$MODE" = "full" ]; then
        printf '\033[38;5;172m[CAVEMAN]\033[0m'
      else
        SUFFIX=$(printf '%s' "$MODE" | tr '[:lower:]' '[:upper:]')
        printf '\033[38;5;172m[CAVEMAN:%s]\033[0m' "$SUFFIX"
      fi

      # Savings suffix: on by default. Opt out via CAVEMAN_STATUSLINE_SAVINGS=0.
      # Reads a pre-rendered string written by caveman-stats.js so we don't shell out
      # to node on every keystroke. Refuses symlinks and strips control bytes —
      # same hardening as the flag file (a local attacker could plant a file with
      # ANSI escape codes otherwise). Until /caveman-stats has run at least once,
      # the suffix file is absent and nothing is rendered — so the default is safe
      # for fresh installs (no fake number, no crash).
      if [ "${CAVEMAN_STATUSLINE_SAVINGS:-1}" != "0" ]; then
        SAVINGS_FILE="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.caveman-statusline-suffix"
        if [ -f "$SAVINGS_FILE" ] && [ ! -L "$SAVINGS_FILE" ]; then
          SAVINGS=$(head -c 64 "$SAVINGS_FILE" 2>/dev/null | tr -d '\000-\037')
          [ -n "$SAVINGS" ] && printf ' \033[38;5;172m%s\033[0m' "$SAVINGS"
        fi
      fi
      ;;
  esac
fi

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
