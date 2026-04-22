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

## CLI

```bash
hybridclaw agent list
hybridclaw agent config <json|--json <json>> [--activate]
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

When `imageAsset` is an `http`/`https` URL or a local file path, `agent config`
imports the image into the target workspace `assets/` directory and stores that
workspace-relative path in the agent registry. Existing workspace-relative
`imageAsset` paths are preserved as provided.

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
  };

  agent?: {
    model?: string | { primary: string; fallbacks?: string[] };
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
7. copies `workspace/` into the agent workspace path
8. restores bundled skills into `workspace/skills/`
9. installs manifest-declared skill imports into `workspace/skills/`
10. installs bundled plugins with the normal plugin installer
11. merges packaged skill config and validated bundled-plugin overrides into
   runtime config
12. calls `ensureBootstrapFiles()` to fill any missing templates

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
