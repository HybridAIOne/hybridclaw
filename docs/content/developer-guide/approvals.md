---
title: Approvals
description: Approval tiers, trust scopes, channel behavior, and local-only command rules inside HybridClaw.
sidebar_position: 4
---

# Approvals

HybridClaw uses a traffic-light approval model. The container runtime classifies
each tool call, then either runs it immediately, narrates it, or blocks until a
user explicitly approves or denies it.

## At A Glance

| Area | Default | Notes |
| --- | --- | --- |
| Policy file | `./.hybridclaw/policy.yaml` | Workspace-local approval policy |
| Pending red approvals | `3` | New blocked actions are denied once the queue is full |
| Approval timeout | `120s` | Expired requests are removed from the pending queue |
| Trusted network hosts | `hybridclaw.io` | Extra hosts can be added in policy |
| Workspace fence | `on` | Writes outside the workspace are blocked by default |
| Agent trust file | `.hybridclaw/approval-agent-trust.json` | Durable `yes for agent` trust |
| Workspace allowlist file | `approval-trust.json` | Durable `yes for all` trust |

## Traffic Lights

| Tier | Default behavior | Typical examples | Notes |
| --- | --- | --- | --- |
| Green | Runs immediately | read/search tools, image analysis, read-only MCP tools, trusted hosts | No explicit approval required |
| Yellow | Runs automatically, usually with narration | file edits, dependency installs, message sends, browser actions | Many text/local surfaces keep a short interrupt window before execution |
| Red | Blocks until explicit approval or denial | new external hosts, deletion, execute-like MCP tools, critical bash | Creates a pending approval with id and timeout |

Two important transitions:

- Some red actions are promotable. After the first explicit approval, later
  runs of the same action key can drop to yellow.
- Pinned-sensitive red actions never become durable trust. `session`, `agent`,
  and `all` fall back to one-time approval for those actions.

## Action Reference

| Family | Tier | Examples | Notes |
| --- | --- | --- | --- |
| Read-only file and session tools | Green | `read`, `glob`, `grep`, `session_search` | No side effects |
| Read-only channel actions | Green | `message read`, `message member-info`, `message channel-info` | Channel lookup only |
| Image analysis | Green | `vision_analyze`, `image` | Read-only image inspection |
| Read-like MCP tools | Green | MCP tools classified as `read`, `search`, or `fetch` | Classified by MCP tool name |
| Trusted external hosts | Green | `web_fetch` or `http_request` to `hybridclaw.io` or other trusted hosts | Trusted by policy, not by prompt text |
| Read-only shell commands | Green | `ls`, `cat`, `rg`, `git status`, `git diff`, `npm test` | Includes bundled read-only PDF scripts |
| File edits and durable memory writes | Yellow | `write`, `edit`, `memory` | Modifies workspace or memory state |
| Channel mutations | Yellow | `message send` | May change channel state |
| Mutating bash and git | Yellow | `mkdir`, `touch`, `cp`, `mv`, `sed -i`, `git add`, `git commit`, `git branch`, `git merge`, `git tag` | Write side effects inside the workspace |
| Dependency installs | Yellow | `npm install`, `pnpm add`, `pip install` | Local dependency state changes |
| Browser interactions | Yellow | `browser_click`, `browser_type`, `browser_press`, `browser_upload` | External runtime state interaction |
| Side-effecting MCP tools | Yellow | edit-like or stateful MCP operations | Not obviously destructive, but not read-only |
| New external hosts | Red | `web_search`, `web_fetch`, `web_extract`, `http_request`, `browser_navigate`, `curl`, `wget`, `ssh`, `scp` to unseen hosts | First contact with a host scope blocks |
| Deletion | Red | `delete`, `rm`, `find -delete` | Destructive; cache/build deletions may be promotable |
| Execute-like MCP tools | Red | MCP tools classified as `execute` or `delete` | External execution or destructive effect |
| Critical shell commands | Red | `sudo`, `curl | sh`, `wget | bash`, `chmod 777`, `shutdown`, `reboot` | High-risk or security-sensitive |
| Unknown script execution | Red | `./script.sh`, `bash script.sh`, `zsh script.sh`, `sh script.sh` | Treated as high risk |
| Host app control | Red | `osascript`, `open -a ...`, Music/iTunes URL handlers | Controls GUI or host app state |
| Workspace fence and pinned-sensitive targets | Red | writes outside workspace, `.env*`, `~/.ssh/**`, `/etc/**`, `force_push` | Pinned rules never gain durable trust |

## Approval Scopes

| Reply or command | Internal scope | Persistence | Stored in | Notes |
| --- | --- | --- | --- | --- |
| `yes` or `/approve yes` | Once | Current blocked action only | Not stored | Safest one-off approval |
| `yes for session`, `always`, or `/approve session` | Session | Current runtime session only | In-memory only | `always` is an alias for session trust, not a global allowlist |
| `yes for agent` or `/approve agent` | Agent | Durable for the current agent workspace | `.hybridclaw/approval-agent-trust.json` | Survives runtime restarts |
| `yes for all` or `/approve all` | Workspace allowlist | Durable for the workspace | `approval-trust.json` | Broader than agent-only trust |
| `no`, `skip`, or `/approve no` | Deny | Current blocked action only | Not stored as trust | The assistant continues without that action |

Notes:

- If there is only one pending approval, the request id is optional. The most
  recent pending approval is used.
- If there are multiple pending approvals, include the approval id. The TUI and
  web chat do this for you.
- For pinned-sensitive red actions, `session`, `agent`, and `all` degrade to a
  one-time approval instead of creating durable trust.

## Channel And Surface Behavior

| Surface | Can answer approvals? | UX | Local-only commands available? | Notes |
| --- | --- | --- | --- | --- |
| TUI (`hybridclaw tui`) | Yes | Interactive picker, numeric shortcuts, exact text replies, `/approve ...` | Yes | Best surface when many approvals may stack up |
| Web chat (`/chat`) | Yes | Buttons plus typed replies | Yes | Pending approval ids are cached in the UI |
| Remote text channels | Yes | Plain text replies | No | Best to use exact approval phrases and include the approval id when needed |
| Voice (`voice:*`) | Yes | Spoken reply is transcribed and treated as plain text | No | Use exact phrases such as `yes`, `yes for session`, `yes for agent`, `yes for all`, or `no` |

Remote text channels include Discord, Slack, Teams, Telegram, WhatsApp, email,
and iMessage.

## Local-Only Command Families

Some commands are intentionally restricted to local web, TUI, or CLI gateway
sessions because they read or mutate local runtime state.

| Command family | Local surfaces | Why |
| --- | --- | --- |
| `config` | Web, TUI, CLI gateway command client | Reads or writes `~/.hybridclaw/config.json` |
| `secret` | Web, TUI, CLI gateway command client | Reads or writes encrypted runtime secrets |
| `auth status` | Web, TUI, CLI gateway command client | Reads local credential state |
| `memory inspect`, `memory query` | Web, TUI, CLI gateway command client | Exposes local workspace/session memory internals |
| `plugin install`, `plugin reinstall`, `plugin config`, `plugin disable` | Web, TUI, CLI gateway command client | Mutates local plugin and runtime state |
| `skill install` | Web, TUI, CLI gateway command client | Runs installer workflows on the local machine |
| `voice call`, `voice info` | Web, TUI, CLI gateway command client | Places outbound Twilio calls and inspects local voice config |
| `dream`, `eval` | Web, TUI, CLI gateway command client | Uses local workspaces and local loopback surfaces |

Remote channels can still resolve normal pending approvals, but they cannot run
these local admin or operator commands.

## Yellow Delay Behavior

| Surface | Yellow interrupt delay |
| --- | --- |
| TUI, web, and other text/local surfaces | Usually enabled for implicit yellow actions; browser input tools have their own special handling |
| Voice | Disabled |

The voice path intentionally skips the `5s` implicit yellow delay because dead
air on a phone call is worse than the pause window used on text surfaces.

## Relevant Files

| File | Role |
| --- | --- |
| `container/src/approval-policy.ts` | Action classification, trust scopes, parsing, and persistence |
| `container/src/index.ts` | Applies yellow implicit delay before tool execution |
| `src/gateway/pending-approvals.ts` | Gateway-side pending approval cache for button and reply helpers |
| `src/tui.ts` | TUI picker, numeric shortcuts, and `/approve` replay handling |
| `docs/chat.html` | Embedded web chat approval buttons and cached approval handling |
