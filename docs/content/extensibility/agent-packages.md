---
title: Agent Packages
description: Portable `.claw` archive format, CLI workflow, manifest fields, and security rules for packaging agents.
sidebar_position: 2
---

# Agent Packages (`.claw`)

HybridClaw can package an agent workspace into a portable `.claw` archive.
A `.claw` file is a ZIP archive with a required `manifest.json` plus the
workspace, optional bundled skills, optional bundled plugins, and optional
references to external skills/plugins.

Use it when you want to:

- back up an agent as one file
- move an agent between machines
- publish a starter agent package
- generate agent packages from scripts without reverse-engineering the runtime

## Agentic TPM Example

The repository includes `agent-packages/agentic-tpm.claw`, a portable agent for
project commitments, dependencies, decisions, risks, and bounded follow-ups.
From a source checkout:

```bash
hybridclaw agent inspect ./agent-packages/agentic-tpm.claw
hybridclaw agent install ./agent-packages/agentic-tpm.claw --id agentic-tpm
```

Its deterministic builder is `agent-packages/agentic-tpm/build.py`; the canonical
bundled skill is `skills/agentic-tpm/`, also available with `/skill agentic-tpm`.
The package contains no credentials, live project data, or active schedules.

## CLI

```bash
hybridclaw agent list
hybridclaw agent config <json|--json <json>> [--activate]
hybridclaw agent defaults <json>
hybridclaw agent reset <agent-id> [--yes] [--keep-history]
hybridclaw agent adopt <agent-id> [--from <agent-id>] [--session <old>=<new>]... [--yes]
hybridclaw agent export [agent-id] [-o <path>] [--description <text>] [--author <text>] [--version <value>] [--dry-run] [--skills <ask|active|all|some>] [--skill <name>]... [--plugins <ask|active|all|some>] [--plugin <id>]...
hybridclaw agent inspect <file.claw>
hybridclaw agent install <file.claw|https://.../*.claw|official:<agent-dir>|github:owner/repo[/<ref>]/<agent-dir>> [--id <id>] [--force] [--skip-skill-scan] [--skip-externals] [--skip-import-errors] [--yes]
hybridclaw agent activate <agent-id>
hybridclaw agent uninstall <agent-id> [--yes]
```

Examples:

```bash
# Export the main agent
hybridclaw agent export main -o /tmp/main.claw

# Inspect a package without extracting it
hybridclaw agent inspect /tmp/main.claw

# Import it as a new agent id
hybridclaw agent install /tmp/main.claw --id demo-agent

# Install a packaged agent from the official claws repo
hybridclaw agent install official:charly-neumann-executive-briefing-chief-of-staff --yes

# Configure an agent from a platform-generated JSON payload
hybridclaw agent config '{"id":"felix","model":"gpt-5.4-mini","markdown":{"IDENTITY.md":"# Felix\n"}}' --activate

# Make one installed agent the default for new requests
hybridclaw agent activate demo-agent

# Remove an installed non-main agent
hybridclaw agent uninstall demo-agent --yes
```

You can control workspace skill bundling during `export`:

```bash
# Ask about each workspace skill (interactive default)
hybridclaw agent export main --skills ask

# Bundle only enabled workspace skills
hybridclaw agent export main --skills active

# Bundle all workspace skills
hybridclaw agent export main --skills all

# Bundle only a named subset
hybridclaw agent export main --skills some --skill 1password --skill apple-calendar

# Bundle only enabled home plugins
hybridclaw agent export main --plugins active

# Bundle all installed home plugins
hybridclaw agent export main --plugins all

# Bundle only a named plugin subset
hybridclaw agent export main --plugins some --plugin demo-plugin --plugin qmd-memory
```

## Restoring Provisioned Defaults

Provisioners can register a reset definition separately from the live workspace:

```bash
hybridclaw agent defaults '{"id":"hy","displayName":"Hy","model":"gpt-6-luna","markdown":{"IDENTITY.md":"# Hy\n"}}'
hybridclaw agent reset hy
```

Reset deletes the chosen agent's files, conversations (including earlier session
instances), memory and scheduled tasks, then recreates its workspace from the
runtime's current templates and the provisioned definition. It restores agent
settings and activates that agent. Other agents and instance credentials remain.
Use `--keep-history` to retain conversations, memory stored in the database and
tasks, or `--yes` to bypass the terminal confirmation. The gateway must be running
and the agent idle; a failed gateway request never triggers offline deletion.

Definitions are stored in `data/agent-defaults/`, outside agent workspaces, and
can be refreshed by the provisioner. They use the config JSON shape below but
require an independent managed workspace and do not support `workspace`,
`extends` or `imageAsset`. Reset refuses the main agent and shared or symlinked
agent directories. The HTTP equivalent is an admin-only
`POST /api/admin/agents/<id>/reset` with `{"confirmation":"RESET AGENT"}`;
it requires `admin.agents.delete` permission. Reset also clears an earlier
`adopt` (below), since the adopted data is gone.

## Importing Another Agent's History

`adopt` moves the user's history from one agent (default `main`) to another,
for example when a user switches to a dedicated companion agent:

```bash
hybridclaw agent adopt hy --from main \
  --session main-<hash>-main=main-<hash>-hy-<persona> --yes
```

It runs in the gateway (which must be running, with both agents idle) and:

- copies the source workspace into the target's, except the target's own
  persona and runtime files (`IDENTITY.md`, `SOUL.md`, `AGENTS.md`, `TOOLS.md`,
  `BOOT.md`, `OPENING.md`, `BOOTSTRAP.md`, `node_modules`,
  `.hybridclaw/workspace-state.json`). Same-named files are replaced, except
  `MEMORY.md` and `memory/*.md`: what the target already had stays below a
  `## Before the import from <agent>` heading. The source workspace stays as
  a backup;
- moves the source's sessions (with messages, scheduled tasks, session memory,
  audit logs, compaction archives and notification bindings), agent-scoped
  memory, canonical context, todos and tracked goals to the target, and
  rewrites `agent:<from>:` session keys;
- renames each `--session <old>=<new>` thread. A `<new>` session that already
  exists is kept as `<new>-before-adopt-<unix ms>`;
- makes the target the default agent, routes the source's mailboxes to it
  (accounts without `agentId` follow the default agent), and turns the
  target's onboarding off.

It prints one JSON line: `{"status":"adopted",...}` with `sessionsMoved`,
`threadsRenamed`, `movedAside` and `filesCopied`; `{"status":"already"}` when
the target already imported from this source; or `{"status":"nothing"}` when
the source has no user messages and no files beyond templates. Importing from
a second source fails until the target is reset. The email channel picks up
the new mail routing right away, without a gateway restart. The HTTP
equivalent is
`POST /api/admin/agents/<to>/adopt` with
`{"confirmation":"ADOPT AGENT","from":"main","sessions":[{"from":"<old>","to":"<new>"}]}`,
which also requires `admin.agents.delete`; a busy agent or a second source
answers 409.

## Configuring Agents From JSON

Use `hybridclaw agent config` when another platform already has the agent
metadata and markdown content as JSON, and you do not need a portable `.claw`
archive. This is the lightweight provisioning path for generated agents in
short-lived sandboxes.

The payload may be the agent config object directly:

```bash
hybridclaw agent config '{"id":"research","name":"Research","model":"gpt-5.4-mini","chatbotId":"bot-123","enableRag":true,"skills":["memory"]}' --activate
```

Or it may wrap the config in `agent` and include workspace markdown files:

```bash
hybridclaw agent config --json '{"agent":{"id":"research","model":"gpt-5.4-mini"},"markdown":{"IDENTITY.md":"# Research\n","BOOT.md":"# Boot\n"}}'
```

`markdown` and `files` are aliases. Each entry overwrites one top-level `.md`
file in the target agent workspace. This is intended for bootstrap files such
as `IDENTITY.md`, `SOUL.md`, `BOOT.md`, `AGENTS.md`, `USER.md`, `TOOLS.md`,
`MEMORY.md`, and `HEARTBEAT.md`.

Omitted agent fields are preserved when the agent already exists, so a later
payload can update only markdown without clearing the model, bot binding, skill
allowlist, or RAG setting. Passing an empty value for a supported agent field
clears that field.

`"onboarding": false` keeps the agent out of first-run onboarding for good: no
`BOOTSTRAP.md`, no hatching turn and no welcome email, also after its
workspace is wiped or the agent is reset from defaults that carry the flag.
Setting it removes an existing `BOOTSTRAP.md`; `null` restores the default.

`emptyChatHeader` sets the heading shown when the agent is selected in an empty
chat. When `imageAsset` is an `http`/`https` URL or a local file path, `agent
config` imports the image into the target workspace `assets/` directory and
stores that workspace-relative path in the agent registry. Existing
workspace-relative `imageAsset` paths are preserved as provided.

Use `.claw` archives instead when you need portability, arbitrary workspace
files, bundled workspace skills, bundled home plugins, or install-time external
skill imports.

## Installing From GitHub Sources

`hybridclaw agent install` accepts:

- a local `.claw` file path
- `official:<agent-dir>` for packaged agents published from
  `HybridAIOne/claws`
- `github:owner/repo/<agent-dir>` to resolve a packaged agent from another
  GitHub claws repository
- `github:owner/repo/<ref>/<agent-dir>` to pin a specific Git ref before
  resolving the packaged archive
- a direct `https://.../*.claw` URL, which HybridClaw downloads before
  validating and installing locally

Examples:

```bash
hybridclaw agent install official:charly-neumann-executive-briefing-chief-of-staff --yes
hybridclaw agent install github:your-org/your-claws-repo/research-agent --yes
hybridclaw agent install github:your-org/your-claws-repo/v1.2.3/research-agent --yes
```

The GitHub forms resolve a packaged archive from `dist/<agent-dir>.claw`.
Selectors must point at the source agent directory name, not a `.claw`
filename.

Use `--skip-import-errors` when you want the main archive install to continue
even if a manifest-declared imported skill fails to fetch or install.

If your package is not exposed through that layout, or you want to install from
release assets or Actions artifacts instead, download the `.claw` file first:

Release assets are the best fit for stable bootstrap links:

```bash
gh release download v1.2.3 \
  --repo your-org/your-private-repo \
  --pattern 'research-agent.claw' \
  --dir /tmp/agent-artifacts

hybridclaw agent inspect /tmp/agent-artifacts/research-agent.claw
hybridclaw agent install /tmp/agent-artifacts/research-agent.claw --id research-agent --yes
```

If you publish packages as GitHub Actions artifacts instead:

```bash
gh run download <run-id> \
  --repo your-org/your-private-repo \
  --name research-agent \
  --dir /tmp/agent-artifacts

hybridclaw agent inspect /tmp/agent-artifacts/research-agent.claw
hybridclaw agent install /tmp/agent-artifacts/research-agent.claw --id research-agent --yes
```

If you only have a direct authenticated asset URL, download it first and then
install the local file:

```bash
curl -L \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -o /tmp/research-agent.claw \
  'https://github.com/.../releases/download/.../research-agent.claw'

hybridclaw agent inspect /tmp/research-agent.claw
hybridclaw agent install /tmp/research-agent.claw --id research-agent --yes
```

For private distribution, prefer GitHub Release assets over Actions artifacts
when possible. Release asset URLs are more stable, and bootstrap scripts are
simpler to maintain.

## Archive Layout

```text
manifest.json
workspace/
  SOUL.md
  IDENTITY.md
  USER.md
  TOOLS.md
  MEMORY.md
  AGENTS.md
  HEARTBEAT.md
  OPENING.md
  BOOT.md
  .hybridclaw/
    policy.yaml
skills/
  <skill-dir>/
    SKILL.md
    ...
plugins/
  <plugin-id>/
    hybridclaw.plugin.yaml
    ...
```

`workspace/` is required. `skills/` and `plugins/` are optional.
Extra reference docs should currently live under `workspace/` (for example
`workspace/notes/guide.md`). v1 does not define a separate `documents/`
section.

## Minimal Manifest

```json
{
  "formatVersion": 1,
  "name": "Research Agent",
  "id": "research-agent"
}
```

## Manifest Fields

```ts
interface ClawManifest {
  formatVersion: 1;
  name: string;
  id?: string;
  description?: string;
  author?: string;
  version?: string;
  createdAt?: string;
  presentation?: {
    displayName?: string;
    imageAsset?: string;
    emptyChatHeader?: string;
  };

  agent?: {
    model?: string | { primary: string };
    enableRag?: boolean;
  };

  skills?: {
    bundled?: string[];
    imports?: Array<{
      source: string;
    }>;
    external?: Array<{
      kind: 'git';
      ref: string;
      name?: string;
    }>;
  };

  plugins?: {
    bundled?: string[];
    external?: Array<{
      kind: 'npm' | 'local';
      ref: string;
      id?: string;
    }>;
  };

  config?: {
    skills?: {
      disabled?: string[];
    };
    plugins?: {
      list?: Array<{
        id: string;
        enabled: boolean;
        config?: Record<string, unknown>;
      }>;
    };
  };
}
```

Implementation lives in
[src/agents/claw-manifest.ts](https://github.com/HybridAIOne/hybridclaw/blob/main/src/agents/claw-manifest.ts).

## Bundled vs External

Bundled entries are copied into the archive. Imported entries are resolved at
install time with the normal `hybridclaw skill import` source grammar.
External entries are only recorded in `manifest.json`.

Example:

```json
{
  "formatVersion": 1,
  "name": "Support Agent",
  "skills": {
    "bundled": ["triage"],
    "imports": [
      {
        "source": "skills-sh/anthropics/skills/pdf"
      }
    ],
    "external": [
      {
        "kind": "git",
        "ref": "https://github.com/example/customer-success-skill.git",
        "name": "customer-success"
      }
    ]
  }
}
```

Current behavior:

- bundled skills are installed into the agent workspace under `skills/`
- imported skills are installed into the agent workspace under `skills/`
- `skills.imports[].source` accepts the same source strings as
  `hybridclaw skill import`
- install also adds that workspace `skills/` directory to `skills.extraDirs`
  so bundled and imported workspace skills are discoverable
- bundled plugins are installed through the normal plugin installer
- bundled plugin config overrides are only imported for bundled plugins and are
  validated against the bundled plugin manifest `configSchema`
- external git refs are shown after install as `git clone` commands; they are
  not auto-installed

## Important External URL Limitation

External skill refs currently support `git` only. GitHub URLs work, but the
manifest must still declare `kind: "git"`.

Valid:

```json
{
  "skills": {
    "external": [
      {
        "kind": "git",
        "ref": "https://github.com/example/my-skill.git"
      }
    ]
  }
}
```

Not currently accepted:

```json
{
  "skills": {
    "external": [
      {
        "kind": "clawhub",
        "ref": "https://clawhub.example/skills/notion"
      },
      {
        "ref": "https://github.com/example/my-skill.git"
      }
    ]
  }
}
```

## What `export` Includes

`hybridclaw agent export` currently:

- supports optional `--description`, `--author`, and `--version` manifest
  metadata
- supports `--dry-run` to preview the manifest path and archive entries without
  writing a `.claw` file
- supports `--skills ask|active|all|some` to control workspace skill bundling
  without prompting through every discovered skill
- supports repeated `--skill <name>` flags together with `--skills some` to
  bundle an explicit subset of workspace skills
- supports `--plugins ask|active|all|some` to control home plugin bundling
  without prompting through every discovered plugin
- supports repeated `--plugin <id>` flags together with `--plugins some` to
  bundle an explicit subset of installed home plugins
- reads the target agent workspace from the normal runtime path
- includes all workspace files except top-level `skills/`, which are stored
  separately under archive `skills/`
- excludes transient and sensitive paths such as `.session-transcripts/`,
  `.hybridclaw-runtime/`, `.env*`, `.git/`, `node_modules/`, `.DS_Store`,
  `Thumbs.db`, and
  `.hybridclaw/workspace-state.json`
- discovers workspace-local skills from `workspace/skills/`
- discovers enabled home plugins from `~/.hybridclaw/plugins/`
- stores current global `skills.disabled`
- stores matching `plugins.list[]` overrides only for bundled plugins, and only
  when they have a manifest `configSchema` or a non-default enabled flag

By default, interactive `export` behaves like `--skills ask --plugins ask`.
In that mode, each prompt offers `yes`, `no`, or `external`: `yes` bundles the
entry, `no` skips it, and `external` records an external reference. Non-
interactive `export` behaves like `--skills all --plugins active`. The CLI
reuses one readline session for the whole export flow.

## What `install` Does

`hybridclaw agent install` currently:

1. resolves the install source into a local archive path
2. validates ZIP safety and archive limits
3. reads and validates `manifest.json`
4. confirms import unless `--yes` is set
5. picks the agent id from `--id`, then `manifest.id`, then sanitized
   `manifest.name`
6. registers the agent in the normal agent registry
7. copies `workspace/` into the agent workspace path without adding missing
   bootstrap templates or any `.git/` directory
8. restores manifest-declared bundled skills into `workspace/skills/`, also
   without `.git/`
9. installs manifest-declared skill imports into `workspace/skills/`
10. installs manifest-declared bundled plugins with the normal plugin installer
11. merges packaged skill config and validated bundled-plugin overrides into
   runtime config

Use `--force` to replace an existing agent workspace or reinstall bundled
plugins during import. Use `--skip-externals` to skip manifest-declared skill
imports and other external references during install.

## What `config` Does

`hybridclaw agent config` currently:

1. parses the quoted JSON payload from the positional argument or `--json`
2. reads agent fields either from the root object or from `agent`
3. validates markdown file names before mutating the registry
4. merges omitted fields with the existing registered agent, when present
5. registers the agent in the normal agent registry
6. calls `ensureBootstrapFiles()` to create the workspace and fill missing
   templates
7. imports `imageAsset` URLs or local file paths into workspace `assets/`
8. overwrites any provided top-level `.md` files from `markdown` or `files`
9. writes `agents.defaultAgentId` into runtime config when `--activate` is set

Markdown file names must be top-level `.md` names. Nested paths such as
`docs/IDENTITY.md`, absolute paths, and traversal segments are rejected. Each
markdown value must be a string and is limited to 200 KB.

## Org-Chart Fields

Agent config JSON supports first-class org-chart fields on each registered
agent:

- `role`: the agent's job title or functional responsibility
- `reportsTo` or `reports_to`: the direct manager agent id
- `delegatesTo` or `delegates_to`: agent ids this agent commonly delegates to
- `peers`: sibling or frequent collaborator agent ids

`reportsTo` is validated as a tree-shaped reporting line. It must reference an
existing registered agent, it cannot point back to the same agent, and cycles
are rejected before the agent is persisted. `delegatesTo` and `peers` are
stored as first-class arrays for routing and presentation; they do not imply
managerial reporting. Delegation and peer relationships are graph edges, not a
tree: cycles are allowed, and any code that traverses those relationships must
maintain its own visited set.

HQ with per-client agencies:

```json
{
  "agents": {
    "list": [
      { "id": "main", "role": "HQ Chief of Staff" },
      {
        "id": "client-acme-lead",
        "role": "Client Agency Lead",
        "reportsTo": "main",
        "delegatesTo": ["client-acme-research", "client-acme-support"],
        "peers": ["client-zenith-lead"]
      },
      {
        "id": "client-acme-research",
        "role": "Research Specialist",
        "reportsTo": "client-acme-lead",
        "peers": ["client-acme-support"]
      },
      {
        "id": "client-acme-support",
        "role": "Support Specialist",
        "reportsTo": "client-acme-lead",
        "peers": ["client-acme-research"]
      }
    ]
  }
}
```

Support hierarchy:

```json
{
  "id": "support-tier-1",
  "role": "Support Specialist",
  "reports_to": "support-lead",
  "delegates_to": ["support-tier-2"],
  "peers": ["support-triage"]
}
```

## What `activate` Does

`hybridclaw agent activate <agent-id>`:

1. validates that the agent exists
2. writes `agents.defaultAgentId` into runtime config
3. makes that agent the default for new requests and fresh web sessions that do
   not specify an agent explicitly

## What `uninstall` Does

`hybridclaw agent uninstall` currently:

1. requires a non-main agent id
2. confirms removal unless `--yes` is set
3. removes the registered agent entry
4. removes the agent workspace root under the normal runtime path
5. removes the agent's workspace `skills/` directory from `skills.extraDirs`

If the agent's folder and registration are already gone but its
`skills.extraDirs` entry remains, the command still runs and removes the entry.
Run it again for an agent uninstalled by an older version.

## What `list` Does

`hybridclaw agent list` prints registered agents in a tab-separated format:

```text
<id>\t<name>\t<model>
```

## Security Rules

`.claw` install rejects:

- absolute paths
- `..` traversal segments
- symlink entries
- encrypted ZIP entries
- archives over these limits:
  - 10,000 entries
  - 100 MB compressed
  - 512 MB uncompressed

Implementation lives in
[src/agents/claw-security.ts](https://github.com/HybridAIOne/hybridclaw/blob/main/src/agents/claw-security.ts).

## Generating `.claw` Files Programmatically

If you are generating `.claw` files from a script or another tool:

1. create a standard ZIP archive
2. write `manifest.json` at the archive root
3. place workspace files under `workspace/`
4. if bundling skills, store each one at `skills/<dir>/...` and list the same
   directory names in `manifest.skills.bundled`
5. if bundling plugins, store each one at `plugins/<id>/...` and list the same
   ids in `manifest.plugins.bundled`
6. if using install-time skill imports, add `manifest.skills.imports[]`
   entries with normal `hybridclaw skill import` source strings
7. if using external skill URLs, use `kind: "git"`; other skill kinds are not
   supported in v1
8. do not rely on a separate `documents/` section in v1; store extra docs under
   `workspace/`

The bundled directory lists in the manifest must match the archive contents
exactly.
