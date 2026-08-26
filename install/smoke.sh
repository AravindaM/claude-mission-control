#!/bin/sh
# End-to-end smoke test with a REAL claude binary and REAL hooks.
# Costs two tiny haiku calls. Run: sh install/smoke.sh
# -u only: the check() pattern counts failures itself; -e would abort on the first failed condition.
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
export MC_DATA_DIR="/tmp/mc-smoke-$$"
export MC_PORT=47913
API="http://127.0.0.1:$MC_PORT"
FAILS=0
check() { if [ "$2" = "0" ]; then echo "  ok: $1"; else echo "  FAIL: $1"; FAILS=$((FAILS + 1)); fi; }

mkdir -p "$MC_DATA_DIR"
node "$REPO/server/src/index.js" > "$MC_DATA_DIR/server.log" 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null; rm -rf "$MC_DATA_DIR" "$SCRATCH"' EXIT
i=0; until curl -s --max-time 1 "$API/api/state" >/dev/null 2>&1; do
  i=$((i+1)); [ "$i" -gt 10 ] && { echo "server never came up"; cat "$MC_DATA_DIR/server.log"; exit 1; }; sleep 1
done
echo "server up"

SCRATCH=$(mktemp -d)
(cd "$SCRATCH" && git init -q -b main && git commit -q --allow-empty -m x)
mkdir -p "$SCRATCH/.claude"
cat > "$SCRATCH/.claude/settings.json" <<EOF
{
  "hooks": {
    "SessionStart": [{"hooks": [{"type": "command", "command": "MC_DATA_DIR=$MC_DATA_DIR MC_PORT=$MC_PORT $REPO/hooks/mc-hook.sh"}]}],
    "SessionEnd": [{"hooks": [{"type": "command", "command": "MC_DATA_DIR=$MC_DATA_DIR MC_PORT=$MC_PORT $REPO/hooks/mc-hook.sh"}]}]
  }
}
EOF

echo "case: unbound session captured end-to-end"
(cd "$SCRATCH" && claude -p "Reply with exactly: ok" --model haiku < /dev/null > /dev/null 2>&1)
sleep 1
grep -q SessionStart "$MC_DATA_DIR/_spool/events.jsonl"; check "spool has SessionStart" "$?"
curl -s "$API/api/state" | jq -e '.now' > /dev/null; check "state serves" "$?"
SESSIONS=$(curl -s "$API/api/state" | jq '[.unassigned[], .tasks[]] | length')
sqlite3 "$MC_DATA_DIR/.index/mission-control.db" "SELECT COUNT(*) FROM sessions" | grep -qv '^0$'; check "session row indexed" "$?"
ls "$MC_DATA_DIR/_unbound/"*/*.jsonl > /dev/null 2>&1; check "transcript archived to _unbound" "$?"

echo "case: auto-attach + brief injection on a bound repo"
curl -s -X POST "$API/api/tasks" -H 'Content-Type: application/json' \
  -d "{\"title\":\"Smoke Task\",\"repoPath\":\"$SCRATCH\"}" > /dev/null
OUT=$(cd "$SCRATCH" && claude -p "If your context contains a line starting with 'mission-control:', reply with that exact line and nothing else. Otherwise reply NONE." --model haiku < /dev/null 2>/dev/null)
sleep 1
BOUND=$(sqlite3 "$MC_DATA_DIR/.index/mission-control.db" "SELECT COUNT(*) FROM sessions WHERE task_id IS NOT NULL")
[ "$BOUND" -ge 1 ]; check "session auto-attached (bound=$BOUND)" "$?"
jq -e 'to_entries | length >= 1' "$MC_DATA_DIR/_spool/bindings.json" > /dev/null; check "bindings.json written" "$?"
echo "$OUT" | grep -q "attached to smoke-task"; check "model saw injected status line (said: $OUT)" "$?"
ls "$MC_DATA_DIR/smoke-task/transcripts/"*.jsonl > /dev/null 2>&1; check "bound transcript archived into task dir" "$?"

echo ""
if [ "$FAILS" -eq 0 ]; then echo "SMOKE PASSED"; else echo "$FAILS SMOKE FAILURES"; exit 1; fi
