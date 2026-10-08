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
| Pending red approvals | `3` | Counted per session; a session's new blocked actions are denied once its queue is full |
| Approval timeout | `120s` | Expired requests are removed from the pending queue |
| Network default | `deny` | Unmatched HTTP/network access falls back to prompt unless changed to `allow` |
| Seeded network rule | `allow hybridaione.github.io:443 * /hybridclaw/** agent=*` | New workspaces start with one explicit allow rule |
| Workspace fence | `on` | Shell writes outside the workspace and scratch space need approval, even in full-auto |
| Agent trust file | `.hybridclaw/approval-agent-trust.json` | Durable `yes for agent` trust |
| Workspace allowlist file | `approval-trust.json` | Durable `yes for all` trust |
| Approval state files | Protected | The agent's own writes, edits, and deletes of `.hybridclaw/**` or `approval-trust.json`, and bash commands naming them, need explicit approval every time, even in full-auto |

## What Approvals Actually Cover

Two different mechanisms are involved:

- Runtime tool approvals are the traffic-light rules in
  `container/src/approval-policy.ts`. They classify tool calls as green,
  yellow, or red.
- Local operator-command restrictions are separate. Commands such as `config`,
  `secret`, `policy`, `plugin ...`, `skill install`, and `skill setup` are
  limited to local TUI/web/CLI surfaces, and a few use their own explicit
  approval flow.

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
  dependency installs are usually yellow. Deletion, unknown scripts, running
  code that `curl` or `wget` fetched, critical shell patterns such as `sudo`,
  host-app control, and writes outside the workspace fence are red.
- Most runtime tools. Read/search tools are green. `write`, `edit`, and
  `memory` are yellow. `delete` is red. `delegate` is green because it is
  internal orchestration; the delegated agent's child tool calls are still
  classified separately. Browser interaction tools are usually yellow. MCP tools
  are classified by the hints their server sends (`readOnlyHint`,
  `destructiveHint`, `openWorldHint`), or by name when it sends none, into
  read/search/fetch, edit/state, or execute/delete groups. A write the server
  marks `openWorldHint: true`, such as sending mail, is red.
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
- `skill install` and `skill setup` are local-only, but running them is treated
  as the explicit operator action rather than going through the same
  traffic-light prompt path.

Approvals also do not stand alone. Sandbox and mount permissions, local-only
command availability, and provider/runtime internals unrelated to user tool
calls are enforced by other layers.

## Traffic Lights

| Tier | Default behavior | Typical examples | Notes |
| --- | --- | --- | --- |
| Green | Runs immediately | read/search tools, image analysis, read-only MCP tools, allowlisted HTTP targets, unmatched network access when `network.default: allow` | No explicit approval required |
| Yellow | Runs automatically, usually with narration | file edits, dependency installs, message sends, browser actions, unmatched network access when `network.default: deny` | The short pre-execution interrupt window is disabled by default; enable it with `approval.implicit_delay_enabled: true` |
| Red | Blocks until explicit approval or denial, or is hard-blocked by policy | policy-blocked hosts, deletion, execute-like MCP tools, MCP writes that reach outside, critical bash | Creates a pending approval with id and timeout unless the rule is an explicit network deny |

Two important transitions:

- Some red actions are promotable. After the first explicit approval, later
  runs of the same action key can drop to yellow.
- Pinned-sensitive red actions never become durable trust, and full-auto never
  approves them. `session`, `agent`, and `all` fall back to one-time approval
  for those actions.

## Approval Modes

Each session has an approval mode. It changes how many of the tiers above stop
for a human. Pick it from the chip next to the model in the web chat composer,
or with `/approvals mode [ask|auto|full]` on any surface.

| Mode | Label | Green | Yellow | Red |
| --- | --- | --- | --- | --- |
| `ask` | Ask first | Runs | Prompts | Prompts; promotable red actions stay red after an approval |
| `auto` (default) | Auto | Runs | Runs | Prompts |
| `full` | Full access | Runs | Runs | Runs, except pinned, explicit-approval, and `full_auto.never_approve` actions |

- The mode is stored per session. A new chat and `/reset` start at `auto`;
  an automatic idle-expiry reset keeps the mode.
- A running `/fullauto` loop always uses `full` until `/fullauto off`.
- Trust you already granted (`yes for session`, `agent`, or `all`) still
  applies in `ask`.
- Every mode change is written to the audit log as `approval.mode_changed`.

## Action Reference

| Family | Tier | Examples | Notes |
| --- | --- | --- | --- |
| Read-only file and session tools | Green | `read`, `glob`, `grep`, `session_search` | No side effects; pinned targets such as `.env*` are red |
| Read-only channel actions | Green | `message read`, `message member-info`, `message channel-info` | Channel lookup only |
| Image analysis | Green | `vision_analyze` | Read-only image inspection |
| Read-like MCP tools | Green | MCP tools classified as `read`, `search`, or `fetch` | Classified by MCP tool name |
| Delegation | Green | `delegate` | Internal orchestration only; child tool calls are classified independently |
| Policy-allowlisted external hosts | Green | `web_fetch`, `web_extract`, `http_request`, `browser_navigate`, `curl`, `wget`, or `web_search` targets matching an allow rule | Rules are evaluated in order; first match wins |
| Read-only shell commands | Green | `ls`, `cat`, `rg`, `git status`, `git diff`, `npm test`, `git log \| head` | Includes bundled read-only PDF scripts. Every command the line runs must be read-only, including pipeline stages, later lines, `$(...)`, and what `find -exec` or `xargs` runs, so `cat x \| sort` is yellow. `2>&1`, `>&2`, and a redirect to `/dev/null` write no file, so `git status 2>&1` and `ls /opt/data 2>/dev/null` stay green |
| File edits and durable memory writes | Yellow | `write`, `edit`, `memory` | Modifies workspace or memory state |
| Channel mutations | Yellow | `message send` | May change channel state |
| Media generation | Yellow | `image_generate`, `video_generate` | External provider call plus generated media written to workspace |
| Mutating bash and git | Yellow | `mkdir`, `touch`, `cp`, `mv`, `sed -i`, `git add`, `git commit`, `git branch`, `git merge`, `git tag`, `git rm --cached`, `git diff --output=FILE`, `find -fprint FILE`, `cc -o FILE` | Write side effects inside the workspace; an absolute target outside it hits the workspace fence |
| Dependency installs | Yellow | `npm install`, `pnpm add`, `pip install` | Local dependency state changes |
| Browser interactions | Yellow | `browser_click`, `browser_type`, `browser_press`, `browser_upload` | External runtime state interaction |
| Side-effecting MCP tools | Yellow | edit-like or stateful MCP operations | Not obviously destructive, but not read-only |
| Unmatched external hosts | Yellow | `web_search`, `web_fetch`, `web_extract`, `http_request`, `browser_navigate`, `curl`, `wget` when no allow/deny rule matches and `network.default: deny` | This is the current “new external host” prompt path |
| Policy-blocked external hosts | Red | Any HTTP/network target matching a `network.rules` entry with `action: deny` | Hard-blocked by approval policy |
| Deletion | Red | `delete`; `rm` and `unlink` with or without flags; `find -delete`, `find -exec rm`, `xargs rm`, `git rm` | Destructive. Promotable only when every target, resolved from the shell's working directory and through any `cd` in the command, is a `node_modules`, `dist`, `build`, `coverage`, or `.cache` path in the workspace or scratch space; `xargs rm`, variables, `~`, and targets that `..` or `cd` take out of the workspace never are. `git rm --cached` keeps the files and is a git write; `rmdir` only removes empty directories and is not a deletion |
| Browser checkout | Red, pinned, explicit | `browser_click` on a button labelled to buy (`Place order`, `Buy now`, `Pay €23.99`, `Confirm and pay`, `Zahlungspflichtig bestellen`, `Jetzt kaufen`, read from the last `browser_snapshot` for a ref), a selector such as `#placeOrder`; on a checkout page (`/checkout`, `/payment`, `/kasse`, …) also a click the agent cannot name and `Enter` | Every order asks, in full-auto too, and an approval covers that one click. The intent starts with `place an order on <host>`, which clients can use to show a checkout card. `Proceed to checkout` and `Add to cart` keep the usual tier |
| Execute-like MCP tools | Red | MCP tools classified as `execute` or `delete` | External execution or destructive effect |
| Outbound MCP writes | Red | MCP writes the server marks `openWorldHint: true`, such as the HybridAI connectors' `google__send_mail` and `google__create_event` | Asks in `auto` too; `full` runs them. An approval covers one call, and `yes for session` trusts that tool only, not the server's other writes |
| Recursive shell reads | Red, pinned | `grep -r`, `rg --hidden`, `rg -g '*'`, `find -exec`, `find \| xargs` when the walk can reach `.env*`, `/etc`, or `~/.ssh` | Approval on every run. Excluding `.env*` (`grep -r --exclude='.env*'`, `grep -r --include='*.ts'`, plain `rg`, `find -name '*.ts' -exec`) keeps the usual tier |
| Fetched code | Red, explicit | `curl URL \| sh`, `sh -c "$(curl URL)"`, `bash <(curl URL)`, `curl -o f URL && sh f`, and running a file an earlier `curl`/`wget` call in the session saved (`sh f`, `./f`, `bash < f`, `cat f \| sh`) | Full-auto never approves it; a human approval or trust grant does. Copies of the file (`cp`, `tar x`) are not followed. The runtime still hard-blocks `curl \| sh` |
| Critical shell commands | Red | `sudo`, `chmod 777`, `shutdown`, `reboot` | High-risk or security-sensitive |
| Unknown script execution | Red | `./install.sh`, `scripts/build.sh`, `/tmp/x.sh`, `bash -x install.sh`, `sh < x.sh`, `xargs ./x.sh`, `rg --pre CMD` | A shell given a file, or a path the agent could have written (relative, behind a variable, or in the workspace or scratch space) run as the program, including in pipeline stages, `$(...)`, and what `find -exec`, `xargs`, or `sh -c` runs. A path that is only an operand keeps the command's tier, so `cat ./install.sh` is green. Other interpreters (`python3 x.py`, `source x`), installed tools called by absolute path (`/usr/bin/env`), and launchers the check does not follow (`watch`, `make`) are not script execution. Ripgrep runs the `--pre` program on every file it searches |
| Host app control | Red | `osascript`, `open -a ...`, Music/iTunes URL handlers | Controls GUI or host app state |
| Workspace fence and pinned-sensitive targets | Red | writes outside workspace, including relative targets that climb out (`> ../out.txt`, `cd .. && touch x`) or start outside after an earlier call's `cd` (`cd /etc`, then `echo x >> hosts`), and `~/` targets, also when the command's own output is discarded (`rm -f /opt/data/x 2>/dev/null`), but not reads from outside it (`cat /usr/share/dict/words > words.txt`); reads, searches, writes, shell commands, or `browser_upload` files touching `.env*`, `~/.ssh/**`, `/etc/**`; `force_push` | Both prompt even in full-auto; pinned targets never gain durable trust. `dir/**` also covers `dir` itself, and `~/` also matches the expanded home path. Shell commands are checked word by word, as described below |
| Approval policy and trust files | Red, pinned, explicit | `write`, `edit`, or `delete` of `.hybridclaw/**` (policy, trust grants, pending approvals), `approval-trust.json`, or `.hybridclaw-runtime/sessions/**`; any bash command that names one | Full-auto never approves it, and every approval covers one call. Reads keep their tier. See below |

Approval classifies a `grep` call by its `path` and `include` arguments, which
do not show which files a directory walk will read. `grep` therefore skips
files matching the built-in pinned paths (`.env*`, `~/.ssh/**`, `/etc/**`)
unless `path` or `include` names a pinned path, which makes the call red. The
output reports how many files were skipped. Paths added under
`approval.pinned_red` gate explicit arguments only; walks do not skip them.

`bash` commands get the pinned check for every operand, not only absolute
paths: relative paths (`cat .env`, `head config/.env.local`), `~` and `$HOME`
paths, `../` escapes resolved from the shell's working directory, redirects
(`cat < .env`), option values (`--env-file=.env`), git revisions
(`git show HEAD:.env`), uploads (`curl -T .env`), and dotfile globs that bash
expands to a pinned name (`cat .e*`). Text that `echo` or `printf` prints
(unless piped into another command) and `grep`/`rg` patterns are not paths.
A recursive read that can reach
pinned files without naming them is pinned red on every run
(`bash:recursive-read`) unless it excludes `.env*`, as in the table above. A
walk rooted at `/`, `~`, or `..`, or run after a `cd` there, is always pinned:
excluding file names cannot keep it out of `/etc` or `~/.ssh`. Like the `grep`
tool, walks consider only the built-in pinned paths. The check is static, so
variables, interpreter scripts, and heredoc bodies are not resolved; it stops
accidental shell reads of pinned files rather than replacing a sandbox.

The shell keeps its working directory between bash calls and across worker
restarts, so each command is checked from where the session's shell stopped.
The classifier reads the directory the shell saved in the session state dir
and, like the shell, starts from the workspace root when nothing is saved or
the saved directory is gone. After `cd /etc`, a later `echo x >> hosts` is a
write to `/etc/hosts` and `rm -rf node_modules` is no cache cleanup. A
docker-exec task sandbox, as the eval harness uses, keeps its working
directory inside the sandbox, out of the classifier's sight, so its commands
are checked from the workspace root. With `container.persistBashState` off,
every call starts in the workspace root.

The workspace fence looks at what a shell command writes: redirect targets,
`tee`, `touch`, `mkdir`, `chmod`, and `chown` operands, `cp` and `mv`
destinations, and write options such as `git --output`, `find -fprint`, and
`curl -o`, resolved from the shell's working directory and through any `cd`
in the command. The value of any other program's `-o` or `--out` counts as a
target too, so `gcc -o /opt/bin/app main.c` is fenced, except for programs
whose `-o` names no file: `grep`, `egrep`, `fgrep`, `rg`, `ls`, `find`, `ps`,
`set`, `ssh`, `scp`, `sftp`, and `xargs`, whose command is checked on its own.
`2>&1` and `>&2` only duplicate a descriptor, and `/dev/null` discards what it
is sent, so none of them is a write: `rm -f /opt/data/x 2>/dev/null` is fenced
like `rm -f /opt/data/x`, and `curl -o /dev/null` saves nothing. Reading from
outside the workspace is not a write, so
`cat /usr/share/dict/words > words.txt`, `cp /opt/data/input.csv .`, and
`python3 /opt/tools/gen.py > out.txt` keep their usual tier. When none of those
targets is an absolute path and the command also runs a program whose writes
are not parsed, such as `rm`, `sed -i`, `mv` (which removes its sources),
`tar`, an installer, an interpreter, `xargs`, or an unknown program, every
unquoted absolute path in the command counts as a possible write, except the
program and the script it runs. That keeps
`sed -i 's/a/b/' /opt/app.conf > log.txt` and
`ls /opt/data > files.txt && python3 cleanup.py files.txt` fenced. An absolute
target in the workspace or scratch space turns that last check off, so
`sed -i 's/a/b/' /opt/app.conf > /tmp/log.txt` is not fenced. The fence is
static too: a path in a variable, or one a script writes, is not seen.

The approval policy, the trust grants, the pending approvals, and the
per-session guard state live in the agent's own workspace, so an agent that
could rewrite them would approve itself. A `write`, `edit`, or `delete` of
those paths, or a bash command that names one, therefore waits for a human
every time: full-auto never approves it, and `yes for session`, `yes for
agent`, and `yes for all` cover that one call. A static check cannot tell a
shell read from a shell write, so read these files with the `read` tool, and
change policy with `hybridclaw policy` or `/policy`. The same limits as above
apply: a path hidden in a variable, interpreter code, or a symlink escapes the
check.

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
  `host` and `paths` take globs; see [Policy Patterns](#policy-patterns).
- Bare site-scope hosts like `github.com` also match subdomains like
  `api.github.com` under the current host-scope rules. There is currently no
  exact-root-only host syntax in `policy.yaml`.
- Omitting `port` means any port. Use `port: 443` only when you want an exact
  port match.
- Every rule needs `action: allow` or `action: deny`, and a `host`. A rule with
  any other action, including `block`, or with no action, no host, or an
  invalid port, is enforced as `deny` for everything it names. A missing host
  covers every host, and an invalid port covers every port. `policy list`
  shows the rule as `Unreadable rule #N, enforced as deny`, and
  `hybridclaw policy` refuses to edit the file until the rule is fixed.
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

### Private Addresses And DNS Rebinding

Browser navigation, the managed-browser guard proxy, and remote audio fetches
reject private IPv6 literals and IPv4-mapped, IPv4-compatible, or NAT64 addresses
that embed private IPv4 destinations. The shared private-range table includes
`192.0.0.0/24`, which contains a cloud metadata endpoint.

The gateway `http_request` proxy also checks DNS answers when opening each
connection, including pinned and self-signed TLS connections, to prevent a host
from switching to loopback or metadata addresses after its initial check.
Private destinations explicitly allowed by workspace network policy retain
that access. Public bracketed IPv6 addresses are classified directly. The
gateway additionally blocks `198.18.0.0/15`; container guards leave that range
available for fake-IP TUN proxies. Discord CDN downloads and iMessage
BlueBubbles URL validation use the shared address classification as well.

## Browser Stealth Policy

Camofox stealth mode is host-allowlisted separately from normal browser
navigation. The default decision is deny. Add a workspace policy rule before
using stealth browsing against a host:

```yaml
browser:
  stealth:
    rules:
      - action: allow
        when:
          predicate: browser_stealth_allowed
          host: example.com
```

The `browser_stealth_allowed` predicate requires `host`, a single host
pattern, and also accepts `skillName` and `agentId`, each a name or a list of
names. Host matching uses the same site-scoped pattern behavior as network
policy, so `example.com` also covers `login.example.com`. This does not grant
network access by itself; normal navigation and tool approval rules still
apply.

A stealth rule's action is `allow`, `deny`, or `block`. A rule with any other
action, or with no action, is enforced as `deny` for the hosts its `when`
matches. A rule the policy cannot read is enforced as `deny` for every host:
an unknown rule key, predicate, or parameter, a `host` that is missing or not
a single pattern, an empty value, or a `when` that is not a mapping or a
non-empty list. Rules earlier in the list still apply first. The stealth
denial names the rule and the problem, for example `Unreadable browser stealth
rule #1 when has unknown browser_stealth_allowed parameter "skilName"
(allowed: host, skillName, agentId), enforced as deny`.

## General Policy Engine

The network policy runtime is implemented as a consumer of the shared policy
engine. The engine evaluates rules as `when` predicate expressions that return
an action. Consumers register their own predicates and decide how actions map to
runtime behavior.

Canonical rule shape:

```yaml
policies:
  - id: nda-leak-block
    description: Block confidential material before it leaves the workspace.
    when:
      all:
        - predicate: leak.label
          equals: confidential
        - predicate: agent
          equals: finance
    action:
      type: block
      reason: NDA material cannot be sent externally.
  - id: budget-soft-limit
    when:
      any:
        - predicate: budget.percent_used
          gte: 80
        - predicate: budget.remaining_usd
          lt: 10
    action:
      type: warn
      reason: Monthly model budget is close to exhaustion.
  - id: redact-token
    when:
      predicate: text.matches
      pattern: "(?i)api[_-]?key"
    action:
      type: transform
      transformer: redact-secrets
```

Expression operators:

- `predicate`: invokes a consumer-registered predicate with the remaining YAML
  keys as parameters, including keys named `all`, `any`, or `not`.
- `all`: every nested expression must match.
- `any`: at least one nested expression must match.
- `not`: the nested expression must not match.

Standard action types are `block`, `warn`, `log`, and `transform`. Consumers
may also use domain-specific actions such as the network consumer's existing
`allow` and `deny` actions. Rules are evaluated in order by default, and the
first match wins unless a consumer explicitly asks the engine to collect all
matches.

Skill availability is also a policy-engine consumer. Static
`skills.disabled` and `skills.channelDisabled.*` entries are applied first,
then workspace `.hybridclaw/policy.yaml` `skill.rules` can deny individual
skills by agent, channel, source, category, capability, role, tenant, or skill
quality score:

```yaml
skill:
  rules:
    - id: deny-sap-outside-finance
      when:
        all:
          - predicate: skill.name
            equals: sap
          - not:
              predicate: actor.role
              equals: finance
      action:
        type: deny
        reason: SAP is finance-only.
```

Skill predicates take these parameters:

| Predicates | Parameters |
| --- | --- |
| `skill.name`, `skill.id`, `skill.source`, `skill.category`, `skill.channel`, `agent.id`, `agent`, `tenant.id` | One of `equals`, `in`, or `oneOf` (a name or a list of names), or `matches` (a regular expression) |
| `skill.capability`, `actor.role` | One of `includes`, `equals`, or `any` (a name, a comma-separated list, or a list) |
| `skill.quality_score` | Any of `gte`, `gt`, `lte`, `lt`, and `equals` (numbers) |

A predicate with no parameters matches when the skill has that field set.

A skill rule's action type is `allow`, `deny`, `block`, `warn`, `log`, or
`confirm-each`. A rule with any other type, or with no action, is enforced as
`deny` for the skills its `when` matches. A rule the policy cannot read is
enforced as `deny` for every skill: an unknown rule key, predicate, or
parameter, two alternative parameters such as `equals` and `matches`, an empty
value, an invalid regular expression, a score bound that is not a number, or a
`when` that is not a mapping or a non-empty list. Rules earlier in the list
still apply first. The skill loader logs such a rule with a reason that
starts with `Unreadable skill rule #N` and, when the rule itself cannot be
read, names the problem before `enforced as deny`.

Secret resolution is another policy-engine consumer. The gateway evaluates it
each time it injects a stored secret into an `http_request` call or a browser
field. The default is allow: a stored secret resolves unless a deny rule
matches, or the workspace policy sets `secret.default: deny` and no allow rule
matches. The seeded workspace policy has no `secret` section, so new workspaces
resolve every stored secret. The gateway's own credentials (`WEB_API_TOKEN`,
`GATEWAY_API_TOKEN`, `HYBRIDCLAW_AUTH_SECRET`, `HYBRIDCLAW_MASTER_KEY`) never
resolve into any sink, and no rule can allow them.

To limit which agents, skills, hosts, and fields can use stored secrets, set
`secret.default: deny` and allow each use. `secret route add` appends an allow
rule scoped to its secret, host, header, and agent, so its routes keep
resolving under a deny default. Prefer the composite `secret_resolve_allowed`
predicate for these rules:

```yaml
secret:
  default: deny
  rules:
    - id: allow-datev-login
      when:
        predicate: secret_resolve_allowed
        id: DATEV_*
        source: store
        sink: dom
        host: "*.datev.de"
        selector: "#password"
        skill: datev-login
        agent: main
      action: allow
```

The secret policy consumer also exposes fine-grained predicates for composed
rules. Use these when the rule needs `all`, `any`, or `not` composition that is
clearer than one composite predicate. Each predicate takes only the parameters
below; where a parameter has several names, set one of them:

| Predicate | Parameters |
| --- | --- |
| `secret_resolve_allowed` | `id` (or `secret`, `secretId`), `source`, `sink` (or `sinkKind`, `sinks`), `host`, `selector` (or `selectors`), `skill` (or `skillName`), `agent` (or `agentId`) |
| `secret.id`, `secret.selector` | `equals`, `matches`, or `in` |
| `secret.source`, `secret.sink`, `skill.name`, `agent.id` | `equals` or `in` |
| `secret.host` | `host`, `equals`, or `matches` |

A parameter value is a string or a list of strings, except that a host is one
pattern. `source` is `store`, `sink` is `dom` for browser fields or `http` for
HTTP requests, and `*` matches any value.

The `selector` says where the secret goes. For `sink: dom` it is the CSS
selector of the browser field. For `sink: http` it is one of these:

| Secret | Selector |
| --- | --- |
| `<secret:NAME>` in the URL | `url` |
| `<secret:NAME>` in a header, a `secretHeaders` entry, or a `tools.httpRequest.authRules` rule | The header name |
| `bearerSecretName` or `bearerSecretRef` | `Authorization` |
| `<secret:NAME>` in a string `body` | `body` |
| `<secret:NAME>` in a `form` field | `form.<field>` |
| `<secret:NAME>` anywhere in a `json` body | `json` |
| `googleServiceAccount` | `googleServiceAccount.clientEmail`, `googleServiceAccount.privateKey`, or `googleServiceAccount.subject` |
| `otcAkSk` | `otcAkSk.accessKeyId`, `otcAkSk.secretAccessKey`, or `otcAkSk.securityToken` |
| `tlsCertificateSha256SecretName` | `tlsCertificateSha256` |

A placeholder in a `json` body reports `json` however deeply it is nested, so
a secret rule cannot tell JSON fields apart: `json.apiKey` and `json.*` match
nothing. Scope such a secret by `host` instead.

`secret.default` and each secret rule's `action` accept `allow`, `deny`, or
`block`, which means the same as `deny`. A rule takes the keys `id`,
`description`, `comment`, `when`, `action`, and `managed_by_*`, and a rule
without `when` matches every resolve. Leaving `secret`, `secret.default`, or
`secret.rules` out, or empty, is the same as not setting it. Anything else the
parser does not know makes every stored-secret resolve for that workspace fail
with `Invalid secret policy in <path>` until the file is fixed. That includes
a typo such as `denied`, a rule without an action, a `secret` section that is
not a mapping, an unknown rule key, predicate, parameter, or `sink` value, and
an empty `when`, `all`, `any`, or parameter.

## Policy Patterns

Paths, hosts, and secret names in `policy.yaml` are globs:
`approval.pinned_red` `paths`, `network.rules` `host` and `paths`, `host` in
secret and browser stealth rules, and secret `id` and `selector`. A glob must
match the whole value, ignoring case. `*`, `**`, and `?` are the only
wildcards; every other character, including `[`, `]`, `{`, and `}`, matches
itself.

| Pattern | `*` | `**` | `?` |
| --- | --- | --- | --- |
| Paths | Any characters except `/` | Any characters, including `/` | One character except `/` |
| Hosts | Any characters except `.`; a leading `*.` and a bare `*` also cross `.` | Any characters, including `.` | One character except `.` |
| Secret `id` and `selector` | Any characters | Same as `*` | One character |

A pinned `dir/**` also covers `dir` itself; a network path `/dir/**` does not
cover `/dir`.

A leading `*.` covers subdomains at any depth: `*.example.com` matches
`a.b.example.com` but not `example.com`. A bare `*` matches every host. Any
other `*` stays inside one label, so `example.*` matches `example.org` but not
`example.co.uk` or `example.attacker.com`; write `example.**` to match across
labels. A host with a wildcard covers only the hosts it spells out:
`ex?mple.com` matches `example.com` but not `api.example.com`, while the bare
host `example.com` also covers its subdomains.

## Approval Scopes

| Reply or command | Internal scope | Persistence | Stored in | Notes |
| --- | --- | --- | --- | --- |
| `yes` or `/approve yes` | Once | Current blocked action only | Not stored | Safest one-off approval |
| `yes for session` or `/approve session` | Session | Until the session's worker exits (5 idle minutes, a provider switch, or a crash; see [Worker State](./runtime.md#worker-state)) | Worker memory only | Best when you are actively iterating in the same session |
| `yes for agent` or `/approve agent` | Agent | Durable for the current agent workspace | `.hybridclaw/approval-agent-trust.json` | Survives runtime restarts |
| `yes for all` or `/approve all` | Workspace allowlist | Durable for the workspace | `approval-trust.json` | Broader than agent-only trust |
| `no`, `skip`, or `/approve no` | Deny | Current blocked action only | Not stored as trust | The assistant continues without that action |

Notes:

- A reply answers only the requests of the session it is sent in. An agent's
  sessions share its workspace, but a `yes` (or an approval id) in one chat
  never approves an action another chat is waiting on.
- If there is only one pending approval, the request id is optional. The most
  recent pending approval in the session is used.
- If there are multiple pending approvals, include the approval id. The TUI and
  web chat do this for you.
- In web chat, `Allow once` sends `/approve yes`, `Allow always` sends
  `/approve all`, and the session/agent buttons send their matching scoped
  approval commands.
- For pinned-sensitive red actions, `session`, `agent`, and `all` degrade to a
  one-time approval instead of creating durable trust.

## Boost Questions

A premium HybridAI tool (such as `image_generate` with Flux) can answer a call
with a boost offer instead of a result. The runtime then ends the turn with an
approval whose id is the offer id and whose `boost` field
(`{ category, modelName, available }`) the apps show as their boost popup. It
asks in every approval mode, full-auto included, and never becomes trust.

- `/boost use <id>`, `yes`, or `yes <id>` repeats the same call with the
  platform's `hybridai/boost` answer `use: true`; `/boost skip <id>`, `no`, or
  `no <id>` repeats it with `use: false`. The model gets only the repeated
  call's result.
- The model never sees the offer, its id, or the boost `_meta`, and cannot
  answer: only a user message does.
- A session has one open boost question. A newer approval replaces it, and it
  expires with the approval timeout; an expired offer lapses without a repeated
  call, so nothing is spent. `/boost` for an offer that is no longer open
  replies without running the model.

## Full-Auto

Full-auto approves yellow and red actions without a prompt. It applies to
sessions with `/fullauto on` and to OpenAI-compatible requests that carry an
agent or eval profile. These actions still wait for a human:

- Pinned-sensitive actions: `.env*`, `~/.ssh/**`, and `/etc/**` targets,
  recursive shell reads that can reach them, force pushes, changes to the
  approval policy and trust files, and `approval.pinned_red` rules, whose
  defaults also cover `rm -rf` on an absolute path. They accept one-time
  approval only, so the next matching call asks again.
- Shell writes outside the workspace and scratch space
  (`bash:workspace-fence`), such as `> /opt/out.txt`, `cp app /usr/local/bin/`,
  or `>> ~/.bashrc`.
- Fetched code (`bash:fetched-code`).
- Tools and action keys listed under `full_auto.never_approve` in
  `.hybridclaw/policy.yaml`.

A `yes for session`, `yes for agent`, or `yes for all` reply to a fence write or
to fetched code also approves later calls of that kind in the same scope.
Hard-denied actions, such as policy-blocked hosts, stay denied. A pending
approval stops a `/fullauto` run. When an unattended full-auto turn hits one,
full-auto turns itself off for the session; answer the approval, then run
`/fullauto on` to continue.

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
| `skill install`, `skill setup` | Web, TUI, CLI gateway command client | Runs installer workflows on the local machine |
| `voice call`, `voice info` | Web, TUI, CLI gateway command client | Places outbound Twilio calls and inspects local voice config |
| `dream`, `eval` | Web, TUI, CLI gateway command client | Uses local workspaces and local loopback surfaces |

Remote channels can still resolve normal pending approvals, but they cannot run
these local admin or operator commands.

## Yellow Delay Behavior

| Surface | Yellow interrupt delay |
| --- | --- |
| TUI, web, and other text/local surfaces | Disabled by default; enable with `approval.implicit_delay_enabled: true` |
| Voice | Disabled |

When the policy switch is enabled, the voice path still skips the `5s` implicit
yellow delay because dead air on a phone call is worse than the pause window
used on text surfaces.

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
| `console/src/routes/chat/message-block.tsx` | Web chat approval buttons and cached approval handling |
