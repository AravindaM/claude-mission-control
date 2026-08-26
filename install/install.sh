#!/bin/sh
# claude-mission-control installer. Idempotent. Run: sh install/install.sh
set -eu
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DATA="${MC_DATA_DIR:-$HOME/claude-tasks}"
PORT="${MC_PORT:-47613}"
LABEL="com.claude-mission-control.agent"
SETTINGS="$HOME/.claude/settings.json"

echo "== preflight =="
[ "$(uname -s)" = "Darwin" ] || {
  echo "FATAL: the background agent uses launchd, so this installer is macOS-only."
  echo "On Linux, run the server yourself (npm start) and register the hooks by hand."
  exit 1
}
for tool in node claude jq curl sqlite3; do
  command -v "$tool" >/dev/null || { echo "FATAL: $tool not found on PATH"; exit 1; }
done
NODE=$(command -v node)
CLAUDE=$(command -v claude)
# launchd gets a bare PATH; everything below must be absolute.
echo "node:   $NODE"
echo "claude: $CLAUDE"

echo "== data dir + config =="
mkdir -p "$DATA/_spool" "$DATA/.index" "$DATA/_unbound" "$DATA/.bin"
cat > "$DATA/.index/config.json" <<EOF
{
  "claudeBin": "$CLAUDE",
  "port": $PORT
}
EOF
cp -f "$REPO/hooks/mc-hook.sh" "$DATA/.bin/mc-hook.sh"
chmod +x "$DATA/.bin/mc-hook.sh"
mkdir -p "$HOME/.local/bin"
cp -f "$REPO/install/cmcctl" "$HOME/.local/bin/cmcctl"
chmod +x "$HOME/.local/bin/cmcctl"

echo "== dashboard build =="
if [ -d "$REPO/dashboard/dist" ]; then
  echo "dist/ present — skipping (delete it to force a rebuild)"
else
  (cd "$REPO" && npm install --silent && cd dashboard && npm install --silent && npm run build)
fi

echo "== hook registration in ~/.claude/settings.json =="
# A fresh Claude install may have no settings file at all; jq needs one to merge into.
mkdir -p "$HOME/.claude"
[ -s "$SETTINGS" ] || echo '{}' > "$SETTINGS"
HOOK_CMD="$DATA/.bin/mc-hook.sh"
MERGED=$(jq --arg cmd "$HOOK_CMD" '
  .hooks = (.hooks // {}) |
  .hooks.SessionStart      = ((.hooks.SessionStart      // []) | map(select((.hooks[0].command // "") != $cmd))) + [{"hooks":[{"type":"command","command":$cmd}]}] |
  .hooks.SessionEnd        = ((.hooks.SessionEnd        // []) | map(select((.hooks[0].command // "") != $cmd))) + [{"hooks":[{"type":"command","command":$cmd}]}] |
  .hooks.UserPromptSubmit  = ((.hooks.UserPromptSubmit  // []) | map(select((.hooks[0].command // "") != $cmd))) + [{"hooks":[{"type":"command","command":$cmd}]}] |
  .hooks.Stop              = ((.hooks.Stop              // []) | map(select((.hooks[0].command // "") != $cmd))) + [{"hooks":[{"type":"command","command":$cmd}]}]
' "$SETTINGS")
echo "--- settings.json diff ---"
printf '%s' "$MERGED" | diff "$SETTINGS" - || true
printf 'Apply this change to %s? [y/N] ' "$SETTINGS"
read -r ANSWER
case "$ANSWER" in
  y|Y)
    cp "$SETTINGS" "$SETTINGS.bak.$(date +%s)"
    printf '%s\n' "$MERGED" > "$SETTINGS"
    echo "hooks registered (backup saved)"
    ;;
  *) echo "SKIPPED hook registration — capture will not work until registered" ;;
esac

echo "== skills =="
mkdir -p "$HOME/.claude/skills"
ln -sfn "$REPO/skills/task" "$HOME/.claude/skills/task"
rm -f "$HOME/.claude/skills/task-save"
echo "linked: /task (bind/create/save in one command)"

echo "== launchd agent =="
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$HOME/Library/LaunchAgents"
sed -e "s|__NODE__|$NODE|g" \
    -e "s|__SERVER__|$REPO/server/src/index.js|g" \
    -e "s|__DATA__|$DATA|g" \
    -e "s|__PATHDIRS__|$(dirname "$NODE"):$(dirname "$CLAUDE"):/usr/bin:/bin|g" \
    "$REPO/install/mission-control.plist.tmpl" > "$PLIST"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
# bootstrap alone doesn't always fire RunAtLoad on a re-registered label
launchctl kickstart "gui/$(id -u)/$LABEL" 2>/dev/null || true

echo "== verify server =="
i=0
until curl -s --max-time 1 "http://127.0.0.1:$PORT/api/state" >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -gt 15 ] && { echo "FATAL: server did not come up — cmcctl logs"; exit 1; }
  sleep 1
done
echo "server UP on 127.0.0.1:$PORT"

echo "== verify claude usable from the launchd-spawned server (Keychain auth) =="
RESULT=$(curl -s --max-time 120 -X POST "http://127.0.0.1:$PORT/api/verify-claude")
echo "$RESULT" | grep -q '"ok":true' \
  && echo "claude round-trip: PASS" \
  || { echo "claude round-trip: FAIL — auto-briefs will not work. Response: $RESULT"; exit 1; }

echo ""
echo "Done."
echo "  Dashboard:  http://127.0.0.1:$PORT"
echo "  CLI:        add 'source $REPO/cli/cmc.sh' to your ~/.zshrc, then: cmc ls"
echo "  Control:    cmcctl status | logs | stop | start"
echo ""
echo "Open a Claude session in any git repo and run /task <name> to start tracking."
