---
name: current-time
description: Return the current system time and timezone by calling a tool instead of guessing.
user-invocable: true
disable-model-invocation: false
metadata:
  hybridclaw:
    category: misc
    short_description: "Current time and timezone."
---
# Current Time

Use when the user asks for the current time, date, timezone, "right now", "what time is it", or similar.

## Workflow

1. Run a real-time command with `bash`:
```bash
date +"%Y-%m-%d %H:%M:%S %Z (%z)"
```

2. Return the result in one short line:
`Current time skill output: <output>`

## Constraints

- Do not estimate or infer time from memory.
- Always use the command output from this turn.
- Keep the response concise unless the user asks for more detail.
