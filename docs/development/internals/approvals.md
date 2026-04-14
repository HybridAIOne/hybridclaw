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
| Policy file | `./.hybridclaw/policy.yaml` | Workspace-local approval and network policy |
| Pending red approvals | `3` | New blocked actions are denied once the queue is full |
| Approval timeout | `120s` | Expired requests are removed from the pending queue |
| Network default | `deny` | Unmatched HTTP/network access falls back to prompt unless changed to `allow` |
| Seeded network rule | `allow hybridclaw.io:443 * /** agent=*` | New workspaces start with one explicit allow rule |
| Workspace fence | `on` | Writes outside the workspace are blocked by default |
| Agent trust file | `.hybridclaw/approval-agent-trust.json` | Durable `yes for agent` trust |
| Workspace allowlist file | `approval-trust.json` | Durable `yes for all` trust |

## What Approvals Actually Cover

Two different mechanisms are involved:

- Runtime tool approvals are the traffic-light rules in
  `container/src/approval-policy.ts`. They classify tool calls as green,
  yellow, or red.
- Local operator-command restrictions are separate. Commands such as `config`,
  `secret`, `policy`, `plugin ...`, and `skill install` are limited to local
  TUI/web/CLI surfaces, and a few use their own explicit approval flow.

In practice, approvals cover:

- Network and host access for runtime tools, including `web_fetch`,
  `web_extract`, `http_request`, `browser_navigate`, `web_search`, and bash
  network calls such as `curl` and `wget`. Declarative host rules live in
  `.hybridclaw/policy.yaml` under `network`.
- Tool-originated outbound API calls such as `http_request` to GitHub or
  Hugging Face. This does not include the model-provider traffic HybridClaw
  itself uses to talk to OpenAI, Anthropic, or other configured providers.
- Shell execution, mainly `bash`. Read-only commands such as `ls`, `cat`, `rg`,
  `git status`, and `git diff` are usually green. Normal mutating commands such
  as `mkdir`, `touch`, `cp`, `mv`, `sed -i`, `git add`, `git commit`, and
  dependency installs are usually yellow. Deletion, unknown scripts, critical
  shell patterns such as `sudo` or `curl | sh`, host-app control, and writes
  outside the workspace fence are red.
- Most runtime tools. Read/search tools are green. `write`, `edit`, and
  `memory` are yellow. `delete` is red. Browser interaction tools are usually
  yellow. MCP tools are classified by name into read/search/fetch, edit/state,
  or execute/delete groups.
- File access and file operations. Reads are mostly green, while writes and
  edits are yellow. Deletion is red. Writes outside the workspace become red
  because of `approval.workspace_fence`.
- Channel mutations such as `message send`, which are usually yellow.
- Host app control such as `osascript` or `open -a ...`, which is red.
- Trust scopes such as `yes`, `yes for session`, `yes for agent`, and `yes for
  all`.

Approvals do not directly control skills as their own category. A skill is just
an instruction layer; the underlying tool calls are what get classified and
approved.

Installation is mixed:

- Plugin dependency installation has a separate explicit approval flow in local
  command handling.
- `skill install` is local-only, but running it is treated as the explicit
  operator action rather than going through the same traffic-light prompt path.

Approvals also do not stand alone. Sandbox and mount permissions, local-only
command availability, and provider/runtime internals unrelated to user tool
calls are enforced by other layers.

## Traffic Lights

| Tier | Default behavior | Typical examples | Notes |
| --- | --- | --- | --- |
| Green | Runs immediately | read/search tools, image analysis, read-only MCP tools, allowlisted HTTP targets, unmatched network access when `network.default: allow` | No explicit approval required |
| Yellow | Runs automatically, usually with narration | file edits, dependency installs, message sends, browser actions, unmatched network access when `network.default: deny` | Many text/local surfaces keep a short interrupt window before execution |
| Red | Blocks until explicit approval or denial, or is hard-blocked by policy | policy-blocked hosts, deletion, execute-like MCP tools, critical bash | Creates a pending approval with id and timeout unless the rule is an explicit network deny |

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
| Policy-allowlisted external hosts | Green | `web_fetch`, `web_extract`, `http_request`, `browser_navigate`, `curl`, `wget`, or `web_search` targets matching an allow rule | Rules are evaluated in order; first match wins |
| Read-only shell commands | Green | `ls`, `cat`, `rg`, `git status`, `git diff`, `npm test` | Includes bundled read-only PDF scripts |
| File edits and durable memory writes | Yellow | `write`, `edit`, `memory` | Modifies workspace or memory state |
| Channel mutations | Yellow | `message send` | May change channel state |
| Mutating bash and git | Yellow | `mkdir`, `touch`, `cp`, `mv`, `sed -i`, `git add`, `git commit`, `git branch`, `git merge`, `git tag` | Write side effects inside the workspace |
| Dependency installs | Yellow | `npm install`, `pnpm add`, `pip install` | Local dependency state changes |
| Browser interactions | Yellow | `browser_click`, `browser_type`, `browser_press`, `browser_upload` | External runtime state interaction |
| Side-effecting MCP tools | Yellow | edit-like or stateful MCP operations | Not obviously destructive, but not read-only |
| Unmatched external hosts | Yellow | `web_search`, `web_fetch`, `web_extract`, `http_request`, `browser_navigate`, `curl`, `wget` when no allow/deny rule matches and `network.default: deny` | This is the current “new external host” prompt path |
| Policy-blocked external hosts | Red | Any HTTP/network target matching a `network.rules` entry with `action: deny` | Hard-blocked by approval policy |
| Deletion | Red | `delete`, `rm`, `find -delete` | Destructive; cache/build deletions may be promotable |
| Execute-like MCP tools | Red | MCP tools classified as `execute` or `delete` | External execution or destructive effect |
| Critical shell commands | Red | `sudo`, `curl | sh`, `wget | bash`, `chmod 777`, `shutdown`, `reboot` | High-risk or security-sensitive |
| Unknown script execution | Red | `./script.sh`, `bash script.sh`, `zsh script.sh`, `sh script.sh` | Treated as high risk |
| Host app control | Red | `osascript`, `open -a ...`, Music/iTunes URL handlers | Controls GUI or host app state |
| Workspace fence and pinned-sensitive targets | Red | writes outside workspace, `.env*`, `~/.ssh/**`, `/etc/**`, `force_push` | Pinned rules never gain durable trust |

## Network Policy

HTTP and web access are controlled by a structured `network` section in
`.hybridclaw/policy.yaml`:

```yaml
network:
  default: deny
  rules:
    - action: allow
      host: "api.github.com"
      port: 443
      methods: ["GET", "POST"]
      paths: ["/repos/**"]
      agent: "*"
      comment: "GitHub API"
    - action: deny
      host: "*.example.com"
      agent: "research"
  presets:
    - github
```

Key behaviors:

- Rules are evaluated in order. The first matching rule wins.
- Rule matching can scope by `host`, `port`, `methods`, `paths`, and `agent`.
- Omitting `port` means any port. Use `port: 443` only when you want an exact
  port match.
- `network.default` applies only to HTTP/network actions. It does not
  auto-approve general `bash`, file writes, deletion, or other non-network
  tools.
- Legacy `approval.trusted_network_hosts` still loads for backward
  compatibility, but it is migrated into structured `network.rules` once the
  policy is rewritten.
- `hybridclaw policy ...` and `/policy ...` are the operator-facing commands
  for inspecting and editing these rules, including bundled presets.

Examples:

- `hybridclaw policy allow api.github.com --methods GET,POST --agent main`
- `hybridclaw policy deny "*.example.com" --agent research`
- `hybridclaw policy preset add github`
- `hybridclaw policy default allow`

## Approval Scopes

| Reply or command | Internal scope | Persistence | Stored in | Notes |
| --- | --- | --- | --- | --- |
| `yes` or `/approve yes` | Once | Current blocked action only | Not stored | Safest one-off approval |
| `yes for session` or `/approve session` | Session | Current runtime session only | In-memory only | Best when you are actively iterating in the same session |
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

## Tips And Tricks

- Use `yes` for one-off actions, `yes for session` while actively iterating,
  `yes for agent` when one agent repeatedly needs the same action, and `yes for
  all` only when the whole workspace should keep that trust.
- If the same host keeps prompting, prefer `hybridclaw policy allow <host>` or
  `/policy allow <host>` over repeatedly using `yes for all`. Policy rules are
  explicit, reviewable, and support agent/method/path scoping.
- Use `hybridclaw policy preset add <name> --dry-run` before applying a preset
  so you can inspect which endpoints will be added.
- Put narrower deny rules before broader allow rules. Network rules are
  evaluated top to bottom, and the first match wins.
- `hybridclaw policy default allow` only affects HTTP/network access. It does
  not auto-approve general `bash`, file writes, deletion, or other non-network
  actions.
- `yes for all` writes durable trust to `approval-trust.json`. That trust is
  separate from declarative `network.rules` in `policy.yaml`.

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
| `policy` | Web, TUI, CLI gateway command client | Reads or writes workspace `.hybridclaw/policy.yaml` and applies bundled network presets |
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
| `container/src/approval-policy.ts` | Action classification, trust scopes, network evaluation, and persistence |
| `container/shared/network-policy.js` | Shared network rule defaults, normalization, and legacy migration |
| `container/src/index.ts` | Applies yellow implicit delay before tool execution |
| `src/policy/policy-store.ts` | Reads and writes structured network policy in `.hybridclaw/policy.yaml` |
| `src/commands/policy-command.ts` | Shared CLI and slash-command policy command runner |
| `src/gateway/pending-approvals.ts` | Gateway-side pending approval cache for button and reply helpers |
| `src/tui.ts` | TUI picker, numeric shortcuts, and `/approve` replay handling |
| `docs/chat.html` | Embedded web chat approval buttons and cached approval handling |
