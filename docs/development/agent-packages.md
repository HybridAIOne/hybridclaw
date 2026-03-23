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
hybridclaw agent pack [agent-id] [-o <path>]
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
documents/
  ...
```

`workspace/` is required. `skills/`, `plugins/`, and `documents/` are optional.

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
      kind: 'clawhub' | 'npm' | 'git' | 'url';
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
      extraDirs?: string[];
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
      },
      {
        "kind": "clawhub",
        "ref": "https://clawhub.example/skills/notion"
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
- external refs are shown after unpack; they are not auto-installed

## Important External URL Limitation

External skill URLs are supported, but the manifest must still declare the
`kind`. HybridClaw does not currently infer `clawhub` vs `git` from a bare URL.

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

Not currently normalized automatically:

```json
{
  "skills": {
    "external": [
      {
        "ref": "https://github.com/example/my-skill.git"
      }
    ]
  }
}
```

## What `pack` Includes

`hybridclaw agent pack` currently:

- reads the target agent workspace from the normal runtime path
- includes all workspace files except top-level `skills/`, which are stored
  separately under archive `skills/`
- discovers workspace-local skills from `workspace/skills/`
- discovers enabled home plugins from `~/.hybridclaw/plugins/`
- stores current global `skills.disabled`
- stores matching `plugins.list[]` overrides for bundled or externally
  referenced plugins

When running in an interactive TTY, `pack` prompts whether each discovered
workspace skill or installed plugin should be bundled or written as an external
reference.

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
9. merges packaged skill/plugin config into runtime config
10. calls `ensureBootstrapFiles()` to fill any missing templates

Use `--force` to replace an existing agent workspace or reinstall bundled
plugins during import.

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
6. if using external skill URLs, always include an explicit `kind`

The bundled directory lists in the manifest must match the archive contents
exactly.
