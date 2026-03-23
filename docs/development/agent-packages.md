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
hybridclaw agent pack [agent-id] [-o <path>] [--description <text>] [--author <text>] [--version <value>] [--dry-run] [--skills <ask|active|all|some>] [--skill <name>]... [--plugins <ask|active|all|some>] [--plugin <id>]...
hybridclaw agent inspect <file.claw>
hybridclaw agent unpack <file.claw> [--id <id>] [--force] [--skip-externals] [--yes]
```

Examples:

```bash
# Export the main agent
hybridclaw agent pack main -o /tmp/main.claw

# Inspect a package without extracting it
hybridclaw agent inspect /tmp/main.claw

# Import it as a new agent id
hybridclaw agent unpack /tmp/main.claw --id demo-agent
```

You can control workspace skill bundling during `pack`:

```bash
# Ask about each workspace skill (interactive default)
hybridclaw agent pack main --skills ask

# Bundle only enabled workspace skills
hybridclaw agent pack main --skills active

# Bundle all workspace skills
hybridclaw agent pack main --skills all

# Bundle only a named subset
hybridclaw agent pack main --skills some --skill 1password --skill apple-calendar

# Bundle only enabled home plugins
hybridclaw agent pack main --plugins active

# Bundle all installed home plugins
hybridclaw agent pack main --plugins all

# Bundle only a named plugin subset
hybridclaw agent pack main --plugins some --plugin demo-plugin --plugin qmd-memory
```

## Bootstrapping from GitHub Artifacts

`hybridclaw agent unpack` currently accepts a local `.claw` file path only.
If your agent packages are published from a private GitHub repository, the
recommended workflow is:

1. download the built `.claw` artifact
2. inspect it locally
3. unpack it into HybridClaw

Release assets are the best fit for stable bootstrap links:

```bash
gh release download v1.2.3 \
  --repo your-org/your-private-repo \
  --pattern 'research-agent.claw' \
  --dir /tmp/agent-artifacts

hybridclaw agent inspect /tmp/agent-artifacts/research-agent.claw
hybridclaw agent unpack /tmp/agent-artifacts/research-agent.claw --id research-agent --yes
```

If you publish packages as GitHub Actions artifacts instead:

```bash
gh run download <run-id> \
  --repo your-org/your-private-repo \
  --name research-agent \
  --dir /tmp/agent-artifacts

hybridclaw agent inspect /tmp/agent-artifacts/research-agent.claw
hybridclaw agent unpack /tmp/agent-artifacts/research-agent.claw --id research-agent --yes
```

If you only have a direct authenticated asset URL, download it first and then
unpack the local file:

```bash
curl -L \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -o /tmp/research-agent.claw \
  'https://github.com/.../releases/download/.../research-agent.claw'

hybridclaw agent inspect /tmp/research-agent.claw
hybridclaw agent unpack /tmp/research-agent.claw --id research-agent --yes
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

  agent?: {
    model?: string | { primary: string; fallbacks?: string[] };
    enableRag?: boolean;
  };

  skills?: {
    bundled?: string[];
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

Implementation lives in [src/agents/claw-manifest.ts](../../src/agents/claw-manifest.ts).

## Bundled vs External

Bundled entries are copied into the archive. External entries are only recorded
in `manifest.json`.

Example:

```json
{
  "formatVersion": 1,
  "name": "Support Agent",
  "skills": {
    "bundled": ["triage"],
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

- bundled skills are unpacked into the agent workspace under `skills/`
- unpack also adds that workspace `skills/` directory to `skills.extraDirs`
  so imported bundled skills are discoverable
- bundled plugins are installed through the normal plugin installer
- bundled plugin config overrides are only imported for bundled plugins and are
  validated against the bundled plugin manifest `configSchema`
- external git refs are shown after unpack as `git clone` commands; they are
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

## What `pack` Includes

`hybridclaw agent pack` currently:

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

By default, interactive `pack` behaves like `--skills ask --plugins ask`.
In that mode, each prompt offers `yes`, `no`, or `external`: `yes` bundles the
entry, `no` skips it, and `external` records an external reference. Non-
interactive `pack` behaves like `--skills all --plugins active`. The CLI
reuses one readline session for the whole pack flow.

## What `unpack` Does

`hybridclaw agent unpack` currently:

1. validates ZIP safety and archive limits
2. reads and validates `manifest.json`
3. confirms import unless `--yes` is set
4. picks the agent id from `--id`, then `manifest.id`, then sanitized
   `manifest.name`
5. registers the agent in the normal agent registry
6. copies `workspace/` into the agent workspace path
7. restores bundled skills into `workspace/skills/`
8. installs bundled plugins with the normal plugin installer
9. merges packaged skill config and validated bundled-plugin overrides into
   runtime config
10. calls `ensureBootstrapFiles()` to fill any missing templates

Use `--force` to replace an existing agent workspace or reinstall bundled
plugins during import.

## What `list` Does

`hybridclaw agent list` prints registered agents in a tab-separated format:

```text
<id>\t<name>\t<model>
```

## Security Rules

`.claw` unpack rejects:

- absolute paths
- `..` traversal segments
- symlink entries
- encrypted ZIP entries
- archives over these limits:
  - 10,000 entries
  - 100 MB compressed
  - 512 MB uncompressed

Implementation lives in [src/agents/claw-security.ts](../../src/agents/claw-security.ts).

## Generating `.claw` Files Programmatically

If you are generating `.claw` files from a script or another tool:

1. create a standard ZIP archive
2. write `manifest.json` at the archive root
3. place workspace files under `workspace/`
4. if bundling skills, store each one at `skills/<dir>/...` and list the same
   directory names in `manifest.skills.bundled`
5. if bundling plugins, store each one at `plugins/<id>/...` and list the same
   ids in `manifest.plugins.bundled`
6. if using external skill URLs, use `kind: "git"`; other skill kinds are not
   supported in v1
7. do not rely on a separate `documents/` section in v1; store extra docs under
   `workspace/`

The bundled directory lists in the manifest must match the archive contents
exactly.
