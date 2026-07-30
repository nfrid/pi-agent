#!/usr/bin/env bash
set -euo pipefail

if ! command -v claude >/dev/null 2>&1; then
  printf '%s\n' 'Claude Code is not installed or is unavailable on PATH.' >&2
  exit 127
fi

effort="${PI_SECOND_OPINION_EFFORT:-medium}"
case "$effort" in
  low | medium | high | xhigh | max) ;;
  *)
    printf 'Invalid PI_SECOND_OPINION_EFFORT: %s\n' "$effort" >&2
    exit 2
    ;;
esac

exec claude \
  -p \
  --model opus \
  --effort "$effort" \
  --permission-mode dontAsk \
  --safe-mode \
  --tools Read,Glob,Grep \
  --no-session-persistence \
  --output-format text
