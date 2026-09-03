#!/bin/sh
# Shell tests for hooks/mc-hook.sh. Run: sh hooks/test/hook.test.sh
set -u
HOOK="$(cd "$(dirname "$0")/.." && pwd)/mc-hook.sh"
STUB="$(cd "$(dirname "$0")" && pwd)/stub-server.mjs"
FAILS=0

check() { # check <name> <condition-result>
  if [ "$2" = "0" ]; then echo "  ok: $1"; else echo "  FAIL: $1"; FAILS=$((FAILS + 1)); fi
}

fresh() {
  WORK=$(mktemp -d)
  export MC_DATA_DIR="$WORK/data"
  # A tiny git repo so the hook can resolve toplevel/branch.
  REPO="$WORK/repo"
  mkdir -p "$REPO" && (cd "$REPO" && git init -q -b main && git commit -q --allow-empty -m x)
  TRANSCRIPT="$WORK/transcript.jsonl"
  echo '{"type":"user"}' > "$TRANSCRIPT"
}

start_payload() {
  printf '{"hook_event_name":"SessionStart","session_id":"%s","source":"%s","cwd":"%s","transcript_path":"%s"}' \
    "$1" "$2" "$REPO" "$TRANSCRIPT"
}

end_payload() {
  printf '{"hook_event_name":"SessionEnd","session_id":"%s","reason":"other","cwd":"%s","transcript_path":"%s"}' \
    "$1" "$REPO" "$TRANSCRIPT"
}

echo "case: MC_INTERNAL guard — no spool, no output"
fresh
OUT=$(start_payload s1 startup | MC_INTERNAL=1 sh "$HOOK")
check "exit-silent" "$?"
[ -z "$OUT" ]; check "no stdout" "$?"
[ ! -f "$MC_DATA_DIR/_spool/events.jsonl" ]; check "no spool line" "$?"

echo "case: server down — spool written, SERVER DOWN line, fast exit"
fresh
export MC_PORT=1 # nothing listens on port 1
START=$(date +%s)
OUT=$(start_payload s2 startup | sh "$HOOK")
RC=$?
ELAPSED=$(( $(date +%s) - START ))
check "exit 0" "$RC"
echo "$OUT" | grep -q "SERVER DOWN"; check "server-down status line" "$?"
grep -q '"session_id":"s2"' "$MC_DATA_DIR/_spool/events.jsonl"; check "spool line written" "$?"
[ "$ELAPSED" -le 4 ]; check "completed fast (${ELAPSED}s)" "$?"

echo "case: SessionEnd bound — transcript copied into task dir"
fresh
export MC_PORT=1
mkdir -p "$MC_DATA_DIR/_spool"
printf '{"s3":"my-task"}' > "$MC_DATA_DIR/_spool/bindings.json"
end_payload s3 | sh "$HOOK"
sleep 0.3
[ -f "$MC_DATA_DIR/my-task/transcripts/transcript.jsonl" ]; check "copied to task dir" "$?"

echo "case: SessionEnd unbound — transcript copied into _unbound/<repo>"
fresh
export MC_PORT=1
end_payload s4 | sh "$HOOK"
sleep 0.3
[ -f "$MC_DATA_DIR/_unbound/repo/transcript.jsonl" ]; check "copied to _unbound" "$?"

echo "case: server up — status line + brief injected on startup"
fresh
PORT=48991
CAPTURE="$WORK/capture.jsonl"; : > "$CAPTURE"
node "$STUB" $PORT "$CAPTURE" >/dev/null 2>&1 &
STUB_PID=$!
sleep 0.5
export MC_PORT=$PORT
OUT=$(start_payload s5 startup | sh "$HOOK")
echo "$OUT" | grep -q "attached to test-task"; check "status line shown" "$?"
echo "$OUT" | grep -q "Task brief"; check "brief injected" "$?"
grep -q '"repo_toplevel"' "$CAPTURE"; check "server received enriched payload" "$?"

echo "case: source=clear — status line only, NO brief"
OUT=$(start_payload s6 clear | sh "$HOOK")
echo "$OUT" | grep -q "attached to test-task"; check "status line shown" "$?"
echo "$OUT" | grep -q "Task brief"; [ "$?" -ne 0 ]; check "brief suppressed on clear" "$?"
kill $STUB_PID 2>/dev/null

echo "case: UserPromptSubmit — spooled+truncated, POSTed, dead silent"
fresh
PORT=48993
CAPTURE="$WORK/capture.jsonl"; : > "$CAPTURE"
node "$STUB" $PORT "$CAPTURE" >/dev/null 2>&1 &
STUB_PID=$!
sleep 0.5
export MC_PORT=$PORT
BIGPROMPT=$(printf 'work on DEMO-301 %.0s' $(seq 1 400))
OUT=$(printf '{"hook_event_name":"UserPromptSubmit","session_id":"s8","cwd":"%s","prompt":"%s"}' "$REPO" "$BIGPROMPT" | sh "$HOOK")
[ -z "$OUT" ]; check "no stdout on prompt event" "$?"
grep -q '"session_id":"s8"' "$MC_DATA_DIR/_spool/events.jsonl"; check "prompt event spooled" "$?"
SPOOLED_LEN=$(jq -r 'select(.session_id=="s8") | .prompt | length' "$MC_DATA_DIR/_spool/events.jsonl")
[ "$SPOOLED_LEN" -le 2000 ]; check "prompt truncated in spool (len=$SPOOLED_LEN)" "$?"
sleep 0.5
grep -q '/api/hooks/prompt' "$CAPTURE"; check "POSTed to prompt endpoint" "$?"
kill $STUB_PID 2>/dev/null

echo "case: Stop — spooled, POSTed to turn endpoint, dead silent"
fresh
PORT=48994
CAPTURE="$WORK/capture.jsonl"; : > "$CAPTURE"
node "$STUB" $PORT "$CAPTURE" >/dev/null 2>&1 &
STUB_PID=$!
sleep 0.5
export MC_PORT=$PORT
OUT=$(printf '{"hook_event_name":"Stop","session_id":"s9","cwd":"%s","transcript_path":"%s","last_assistant_message":"done"}' "$REPO" "$TRANSCRIPT" | sh "$HOOK")
RC=$?
check "exit 0" "$RC"
# Stop fires after every assistant response; ANY stdout would be injected
# straight back into the session's context.
[ -z "$OUT" ]; check "no stdout on stop event" "$?"
grep -q '"session_id":"s9"' "$MC_DATA_DIR/_spool/events.jsonl"; check "stop event spooled" "$?"
sleep 0.5
grep -q '/api/hooks/turn' "$CAPTURE"; check "POSTed to turn endpoint" "$?"
kill $STUB_PID 2>/dev/null

echo "case: Stop with server down — still spooled, still silent, still fast"
fresh
export MC_PORT=1
START=$(date +%s)
OUT=$(printf '{"hook_event_name":"Stop","session_id":"s10","cwd":"%s","transcript_path":"%s"}' "$REPO" "$TRANSCRIPT" | sh "$HOOK")
RC=$?
ELAPSED=$(( $(date +%s) - START ))
check "exit 0" "$RC"
[ -z "$OUT" ]; check "no stdout" "$?"
grep -q '"session_id":"s10"' "$MC_DATA_DIR/_spool/events.jsonl"; check "spooled while server down" "$?"
[ "$ELAPSED" -le 4 ]; check "completed fast (${ELAPSED}s)" "$?"

echo "case: MC_TASK is passed through so the server can bind by name"
fresh
PORT=48995
CAPTURE="$WORK/capture.jsonl"; : > "$CAPTURE"
node "$STUB" $PORT "$CAPTURE" >/dev/null 2>&1 &
STUB_PID=$!
sleep 0.5
export MC_PORT=$PORT
OUT=$(start_payload s11 startup | MC_TASK=my-task sh "$HOOK")
grep -q '"mc_task":"my-task"' "$CAPTURE"; check "mc_task reached the server" "$?"
grep -q '"mc_task":"my-task"' "$MC_DATA_DIR/_spool/events.jsonl"; check "mc_task spooled too" "$?"
echo "$OUT" | grep -q "Task brief"; check "brief still injected" "$?"
kill $STUB_PID 2>/dev/null

echo "case: no MC_TASK — the field is absent, not empty"
fresh
PORT=48996
CAPTURE="$WORK/capture.jsonl"; : > "$CAPTURE"
node "$STUB" $PORT "$CAPTURE" >/dev/null 2>&1 &
STUB_PID=$!
sleep 0.5
export MC_PORT=$PORT
start_payload s12 startup | sh "$HOOK" >/dev/null
grep -q 'mc_task' "$CAPTURE"; [ "$?" -ne 0 ]; check "no mc_task key when unset" "$?"
kill $STUB_PID 2>/dev/null

echo "case: oversized brief truncated to 8KB"
fresh
PORT=48992
CAPTURE="$WORK/capture.jsonl"; : > "$CAPTURE"
node "$STUB" $PORT "$CAPTURE" 20000 >/dev/null 2>&1 &
STUB_PID=$!
sleep 0.5
export MC_PORT=$PORT
OUT=$(start_payload s7 startup | sh "$HOOK")
LEN=$(printf '%s' "$OUT" | wc -c | tr -d ' ')
[ "$LEN" -le 9000 ]; check "output capped (len=$LEN)" "$?"
kill $STUB_PID 2>/dev/null

echo ""
if [ "$FAILS" -eq 0 ]; then echo "ALL HOOK TESTS PASSED"; exit 0; else echo "$FAILS FAILURES"; exit 1; fi
