#!/bin/sh
# claude-mission-control capture hook (SessionStart + SessionEnd).
# Contract: ALWAYS exit 0, never block a Claude session, and nothing may
# reach stdout except the deliberate SessionStart context injection.
[ -n "$MC_INTERNAL" ] && exit 0

IN=$(cat)
DATA="${MC_DATA_DIR:-$HOME/claude-tasks}"
PORT="${MC_PORT:-47613}"

EV=$(printf '%s' "$IN" | jq -r '.hook_event_name // empty' 2>/dev/null)
[ -z "$EV" ] && exit 0
SID=$(printf '%s' "$IN" | jq -r '.session_id // empty')
CWD=$(printf '%s' "$IN" | jq -r '.cwd // empty')

TOP=$(cd "$CWD" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null)
BR=$(cd "$CWD" 2>/dev/null && git rev-parse --abbrev-ref HEAD 2>/dev/null)

# Prompts can be huge; the spool only needs enough to find a Jira key.
# last_assistant_message is dropped outright: Stop fires after every response, the
# server never reads it, and ingest does a full readFileSync of the spool on every
# hook event — keeping whole responses would make that quadratic.
# MC_TASK is set by `cmc continue`: it names the task this session should bind to.
# Repo matching cannot serve a directory holding several tasks, so an explicit
# name is the only thing that can bind a fresh session there.
LINE=$(printf '%s' "$IN" | jq -c --arg top "$TOP" --arg br "$BR" --arg ts "$(date +%s)" \
  --arg mct "${MC_TASK:-}" \
  '. + {repo_toplevel:$top, git_branch:$br, ts:($ts|tonumber)}
   | (if $mct == "" then . else . + {mc_task:$mct} end)
   | del(.last_assistant_message)
   | if .prompt then .prompt = (.prompt | .[0:2000]) else . end' 2>/dev/null)
[ -z "$LINE" ] && exit 0

# Disk first — capture must survive a dead server.
mkdir -p "$DATA/_spool" 2>/dev/null
printf '%s\n' "$LINE" >> "$DATA/_spool/events.jsonl" 2>/dev/null

if [ "$EV" = "SessionEnd" ]; then
  TP=$(printf '%s' "$IN" | jq -r '.transcript_path // empty')
  if [ -n "$TP" ] && [ -f "$TP" ]; then
    SLUG=$(jq -r --arg s "$SID" '.[$s] // empty' "$DATA/_spool/bindings.json" 2>/dev/null)
    if [ -n "$SLUG" ]; then
      DEST="$DATA/$SLUG/transcripts"
    else
      DEST="$DATA/_unbound/$(basename "${TOP:-$CWD}")"
    fi
    mkdir -p "$DEST" 2>/dev/null
    cp -f "$TP" "$DEST/" 2>/dev/null
  fi
  curl -s --max-time 2 -X POST -H 'Content-Type: application/json' -d "$LINE" \
    "http://127.0.0.1:$PORT/api/hooks/session-end" >/dev/null 2>&1 &
  exit 0
fi

if [ "$EV" = "UserPromptSubmit" ]; then
  # Fires on EVERY prompt: must be silent (stdout would inject into context)
  # and non-blocking.
  curl -s --max-time 2 -X POST -H 'Content-Type: application/json' -d "$LINE" \
    "http://127.0.0.1:$PORT/api/hooks/prompt" >/dev/null 2>&1 &
  exit 0
fi

if [ "$EV" = "Stop" ]; then
  # Fires after EVERY assistant response: must be silent (stdout would inject
  # into context) and non-blocking. Its whole job is proof of life — it revokes
  # the ended_at that the reconciler's idle heuristic and SessionEnd(reason:
  # "resume") both guess wrong on a session that is still working.
  curl -s --max-time 2 -X POST -H 'Content-Type: application/json' -d "$LINE" \
    "http://127.0.0.1:$PORT/api/hooks/turn" >/dev/null 2>&1 &
  exit 0
fi

if [ "$EV" = "SessionStart" ]; then
  RESP=$(curl -s --max-time 2 -X POST -H 'Content-Type: application/json' -d "$LINE" \
    "http://127.0.0.1:$PORT/api/hooks/session-start" 2>/dev/null)
  if [ -n "$RESP" ]; then
    printf '%s' "$RESP" | jq -r '.status_line // empty' 2>/dev/null
    SRC=$(printf '%s' "$IN" | jq -r '.source // empty')
    case "$SRC" in
      startup|resume)
        BRIEF=$(printf '%s' "$RESP" | jq -r '.brief // empty' 2>/dev/null | head -c 8192)
        [ -n "$BRIEF" ] && printf '%s\n' "$BRIEF"
        ;;
    esac
  else
    echo "mission-control: SERVER DOWN — capture spooling locally"
  fi
fi
exit 0
