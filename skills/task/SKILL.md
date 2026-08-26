---
name: task
description: Fire-and-forget mission-control task command. `/task <short-ref>` binds this session to a matching task or creates one. `/task` with no argument saves a background brief (bound session) or auto-creates a task named from the conversation (unbound session).
---

# /task — one curl, never blocks

Run exactly ONE command (substitute the argument, or an empty string if none was given):

```sh
curl -s --max-time 3 -X POST "http://127.0.0.1:${MC_PORT:-47613}/api/sessions/$CLAUDE_CODE_SESSION_ID/task" \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg ref "<argument or empty>" --arg cwd "$PWD" \
        --arg top "$(git rev-parse --show-toplevel 2>/dev/null)" \
        '{ref:$ref, cwd:$cwd, repoToplevel:$top}')"
```

Report exactly one line based on the JSON response, then stop:

| response | report |
|---|---|
| `action: "bound"` | `Bound to <task.slug> (status: <task.status>)` |
| `action: "created"` | `Created and bound to <task.slug>` |
| `action: "brief-queued"` | `Brief queued for <slug> (generating in background)` |
| `action: "naming"` | `Creating a task from this session's context in the background — it will appear on the dashboard shortly` |
| `action: "error"` | the `message` field verbatim |
| HTTP 409 | `Ambiguous — matches: <candidates joined by ", ">. Re-run /task with one of these.` |

If curl itself fails (server down): when an argument was given, append a `bind_intent` line to the offline spool and say capture is offline; with no argument just say the server is down (`cmcctl status`):

```sh
mkdir -p "${MC_DATA_DIR:-$HOME/claude-tasks}/_spool"
printf '{"hook_event_name":"bind_intent","session_id":"%s","task_title":"%s","jira_key":"","cwd":"%s","repo_toplevel":"%s","ts":%s}\n' \
  "$CLAUDE_CODE_SESSION_ID" "<argument>" "$PWD" "<toplevel>" "$(date +%s)" \
  >> "${MC_DATA_DIR:-$HOME/claude-tasks}/_spool/events.jsonl"
```

Never run more than the one curl (plus the fallback if it failed). No mode probing, no extra reads.
