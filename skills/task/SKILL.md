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

`<argument>` is either a task name or one of the reserved verbs `show`, `done`,
`archive`. Pass it through verbatim — the server routes it.

| argument | what it does |
|---|---|
| a name | bind to that task, creating it if it does not exist |
| *(empty)* | save a brief of this session now |
| `show` | print the bound task's brief |
| `done` | mark the bound task done |
| `archive` | close it out: a final brief is written, then its transcripts are deleted |

Report based on the JSON response, then stop:

| response | report |
|---|---|
| `action: "bound"` | `Bound to <task.slug> (status: <task.status>)`, then the `brief` field verbatim below it |
| `action: "created"` | `Created and bound to <task.slug>` |
| `action: "shown"` | the `brief` field verbatim, nothing else |
| `action: "done"` | `<slug> marked done` |
| `action: "archived"` | `<slug> archived — closing brief being written, then its transcripts are removed` |
| `action: "brief-queued"` | `Brief queued for <slug> (generating in background)` |
| `action: "naming"` | `Creating a task from this session's context in the background — it will appear on the dashboard shortly` |
| `action: "error"` | the `message` field verbatim |
| HTTP 409 | `Ambiguous — matches: <candidates joined by ", ">. Re-run /task with one of these.` |

On `bound` and `shown` the `brief` field is the point: print it in full, so the
task's context lands in this session. That is how a session picks up work it was
not started with — `cmc continue <task>` does the same thing at session start.

A task whose name collides with a verb stays reachable by its full slug, which
never equals a bare verb.

If curl itself fails (server down): when an argument was given, append a `bind_intent` line to the offline spool and say capture is offline; with no argument just say the server is down (`cmcctl status`):

```sh
mkdir -p "${MC_DATA_DIR:-$HOME/claude-tasks}/_spool"
printf '{"hook_event_name":"bind_intent","session_id":"%s","task_title":"%s","jira_key":"","cwd":"%s","repo_toplevel":"%s","ts":%s}\n' \
  "$CLAUDE_CODE_SESSION_ID" "<argument>" "$PWD" "<toplevel>" "$(date +%s)" \
  >> "${MC_DATA_DIR:-$HOME/claude-tasks}/_spool/events.jsonl"
```

Never run more than the one curl (plus the fallback if it failed). No mode probing, no extra reads.
