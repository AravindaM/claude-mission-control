# claude-mission-control CLI.
# Source from your shell rc:  source <path-to-repo>/cli/cmc.sh
# Functions (not a script) so `cmc resume` can cd your current shell.

cmc() {
  local port="${MC_PORT:-47613}" data="${MC_DATA_DIR:-$HOME/claude-tasks}"
  local api="http://127.0.0.1:$port"

  case "${1:-}" in
    ls)
      local state
      state=$(curl -s --max-time 2 "$api/api/state" 2>/dev/null)
      if [ -n "$state" ]; then
        printf '%s\n' "$state" | jq -r '
          (["TASK","STATUS","JIRA","LIVE","LAST ACTIVITY"] | @tsv),
          (.now as $now | .tasks[] | select(.archived == 0) |
            [ .slug, .status, (.jira_key // "-"), (.live_sessions | tostring),
              (if .last_activity_at then ((($now - .last_activity_at) / 60000 | floor | tostring) + "m ago") else "-" end)
            ] | @tsv)' | column -t -s "$(printf '\t')"
      else
        echo "(server down — reading files)"
        local f
        for f in "$data"/*/BRIEF.md; do
          [ -f "$f" ] || continue
          awk '/^slug:/{s=$2} /^status:/{st=$2} /^archived: false/{a=1} END{if(a) printf "%-40s %s\n", s, st}' "$f"
        done
      fi
      ;;

    continue|cont)
      # Same task, new session. `resume` reloads a whole transcript; this carries
      # only the brief, which is the point — a clean context window that still
      # knows what it is working on. MC_TASK binds it, since a directory holding
      # several tasks cannot be matched by repo.
      local query="${2:-}" state line slug repo
      state=$(curl -s --max-time 2 "$api/api/state" 2>/dev/null)
      if [ -z "$state" ]; then echo "cmc: server down — start it with: cmcctl start" >&2; return 1; fi
      line=$(printf '%s' "$state" | jq -r --arg q "$query" '
        .tasks[] | select(.archived == 0) | select(.slug | contains($q)) |
        [.slug, (.repo_path // .last_cwd // "")] | @tsv')
      if [ -z "$line" ]; then echo "cmc: no task matches '$query'" >&2; return 1; fi
      if [ "$(printf '%s\n' "$line" | wc -l | tr -d ' ')" -gt 1 ]; then
        if command -v fzf >/dev/null 2>&1; then
          line=$(printf '%s\n' "$line" | fzf --with-nth=1 --height=40%)
        else
          printf '%s\n' "$line" | nl -w2 -s') ' | cut -f1 >&2
          printf 'pick #: ' >&2; local n; read -r n
          line=$(printf '%s\n' "$line" | sed -n "${n}p")
        fi
      fi
      [ -z "$line" ] && return 1
      slug=$(printf '%s' "$line" | cut -f1)
      repo=$(printf '%s' "$line" | cut -f2)
      if [ -n "$repo" ] && [ -d "$repo" ]; then cd "$repo" || return 1; fi
      echo "cmc: continuing $slug in a NEW session (brief only) in ${repo:-$PWD}"
      MC_TASK="$slug" claude
      ;;

    resume)
      local query="${2:-}" state line slug repo sid transcript
      state=$(curl -s --max-time 2 "$api/api/state" 2>/dev/null)
      if [ -z "$state" ]; then echo "cmc: server down — start it with: cmcctl start" >&2; return 1; fi
      local candidates
      candidates=$(printf '%s' "$state" | jq -r --arg q "$query" '
        .tasks[] | select(.archived == 0) | select(.slug | contains($q)) |
        [.slug, (.repo_path // .last_cwd // ""), (.last_session_uuid // ""), (.last_transcript_path // "")] | @tsv')
      if [ -z "$candidates" ]; then echo "cmc: no task matches '$query'" >&2; return 1; fi
      if [ "$(printf '%s\n' "$candidates" | wc -l | tr -d ' ')" -gt 1 ]; then
        if command -v fzf >/dev/null 2>&1; then
          line=$(printf '%s\n' "$candidates" | fzf --with-nth=1 --height=40%)
        else
          printf '%s\n' "$candidates" | nl -w2 -s') ' | cut -f1 >&2
          printf 'pick #: ' >&2; local n; read -r n
          line=$(printf '%s\n' "$candidates" | sed -n "${n}p")
        fi
      else
        line="$candidates"
      fi
      [ -z "$line" ] && return 1
      slug=$(printf '%s' "$line" | cut -f1)
      repo=$(printf '%s' "$line" | cut -f2)
      sid=$(printf '%s' "$line" | cut -f3)
      transcript=$(printf '%s' "$line" | cut -f4)
      if [ -n "$repo" ] && [ -d "$repo" ]; then cd "$repo" || return 1; fi
      # Existence check, not date math: --resume only if the live transcript
      # survives. Which mode you get changes the context cost by ~100x, so say it
      # rather than deciding silently.
      if [ -n "$sid" ] && [ -n "$transcript" ] && [ -f "$transcript" ]; then
        echo "cmc: reopening $slug — full session, in ${repo:-$PWD}"
        claude --resume "$sid"
      else
        echo "cmc: $slug has no stored session left — starting a new one with its brief"
        echo "     (this is what 'cmc continue $slug' does deliberately)"
        MC_TASK="$slug" claude
      fi
      ;;

    digest)
      local digest
      digest=$(curl -s --max-time 3 "$api/api/digest" 2>/dev/null)
      if [ -z "$digest" ]; then echo "cmc: server down — cmcctl status" >&2; return 1; fi
      printf '%s' "$digest" | jq -r '
        .now as $now | .tasks[] |
        "[1m━━ \(.slug)[0m  [\(.status)]" +
        (if .jira_key then "  \(.jira_key)" else "" end) +
        (if .last_activity_at then "  (" + ((($now - .last_activity_at) / 86400000 | floor | tostring)) + "d ago)" else "" end) +
        "\n\(.brief)\n"'
      ;;

    *)
      cat >&2 <<'USAGE'
usage:
  cmc ls                  list active tasks
  cmc resume <task>       reopen that task's last session — full context
  cmc continue <task>     new session carrying only the task's brief
  cmc digest              print every active brief
USAGE
      return 2
      ;;
  esac
}
