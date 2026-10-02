---
name: current-time
description: The current date, time, and timezone are in the `Current Date & Time` line of the latest `<context>` block; answer from it directly, without reading this skill or calling a tool.
user-invocable: true
disable-model-invocation: false
metadata:
  hybridclaw:
    category: misc
    short_description: "Current time and timezone."
    tags:
      - time
      - date
      - timezone
      - utility
---
# Current Time

Each turn carries a `<context>` block whose `Current Date & Time` line holds
the weekday, date, and time to the minute when the turn started, followed by
the IANA timezone in parentheses. The zone is the user's `USER.md` timezone,
else the host's. Older `<context>` blocks in the history show older times.

- Answer from the latest `Current Date & Time` line, without a tool call.
- For another timezone, convert from that line.
- Only if the latest `<context>` block has no `Current Date & Time` line, run
  `date +"%Y-%m-%d %H:%M %Z (%z)"` with `bash`.
