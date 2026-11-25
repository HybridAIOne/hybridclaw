---
name: hybridclaw-help
description: HybridClaw help and self-configuration. Primary skill for product questions about setup, configuration, commands, runtime behavior, and release notes, and for any request to change how this assistant itself is set up, such as who may call or message it, its channels, models, or tools.
user-invocable: true
metadata:
  hybridclaw:
    category: misc
    short_description: "HybridClaw product help."
    tags:
      - hybridclaw
      - docs
      - configuration
      - commands
      - changelog
      - help
    related_skills:
      - feature-planning
---
# HybridClaw Help

Use this skill for product-specific HybridClaw questions such as:

- how to configure a feature
- where config lives, or changing a setting
- what a command does
- how a subsystem behaves
- what changed in a recent release
- where a documented workflow is described

This is the default skill for HybridClaw product questions. Prefer it over
generic service skills when the question is about HybridClaw itself, its built-in
features, its channel integrations, or its documented configuration.

## Core Rule

For HybridClaw behavior, commands, configuration, architecture, release notes,
or runtime locations: consult public docs URLs first. Do not assume repo source
files are present in the current workspace. npm installs may include packaged
docs, but the agent may still only have direct access to web URLs.

Use `web_fetch` or `web_extract` against the public docs site or raw GitHub URLs
before answering from memory.

## Canonical Sources

The browser docs are at `https://hybridaione.github.io/hybridclaw/docs/`.
For `web_fetch` and `web_extract`, use the static Markdown under
`https://hybridaione.github.io/hybridclaw/content/`; the browser shell requires
JavaScript. Start with the narrowest relevant source:

- `https://hybridaione.github.io/hybridclaw/content/agents.md` — index of all docs
- `https://hybridaione.github.io/hybridclaw/content/reference/configuration.md`
- `https://hybridaione.github.io/hybridclaw/content/reference/commands.md`
- `https://hybridaione.github.io/hybridclaw/content/README.md`
- `https://raw.githubusercontent.com/HybridAIOne/hybridclaw/main/config.example.json`
- `https://raw.githubusercontent.com/HybridAIOne/hybridclaw/main/README.md`
- `https://raw.githubusercontent.com/HybridAIOne/hybridclaw/main/CHANGELOG.md`

Follow the Markdown index's relative links against its URL. Static Markdown
pages do not implement `?search=` filtering; select the relevant linked page.

Only widen into implementation files when the docs are missing, incomplete, or
ambiguous. If code inspection is required, use local package files when they are
directly accessible; otherwise use GitHub source URLs instead of assuming `src/`
exists in the workspace.

## Default Workflow

1. Identify the question type: config, command, behavior, architecture, or release history.
2. Fetch the most likely public doc or raw GitHub source first.
3. If the right page is not obvious, fetch the Markdown index and follow the relevant page link.
4. If needed, confirm with the matching implementation file or GitHub source instead of guessing.
5. Answer narrowly and concretely.
6. Include the exact config keys, command names, URLs, file paths, or version headings that support the answer.

## Changing Config

When the user asks for a settings change ("add +4915123456789 to the numbers
that can call"), make it yourself with the `hybridclaw` CLI in a shell. Do not
send them to the admin console or open it in a browser: it needs a human login.

1. Find the exact key in the docs, e.g. `voice.allowFrom` for phone callers.
2. Read it: `hybridclaw config get <key>`.
3. Change it:
   - one entry of a list: `hybridclaw config add <key> <entry>` or
     `hybridclaw config remove <key> <entry>`. Other entries stay. To remove,
     pass the entry exactly as `get` printed it.
   - anything else: `hybridclaw config set <key> <value>` (JSON when possible).
     `set` replaces the whole value, so never use it to add to a list.
4. Check the value the command printed against the user's message, digit by
   digit for phone numbers, and fix a mismatch before you reply. Report it.
   Most changes apply without a restart; the docs say when one is needed.

Changes that only take effect together say so in the docs, e.g. callers are
gated only while `voice.callerPolicy` is `allowlist`: if it is `open`, adding a
number changes nothing, so tell the user and ask before switching the policy.
`hybridclaw config revisions` lists earlier versions and
`hybridclaw config revisions rollback <id>` restores one.

## Answer Style

- Be laser-focused on the asked feature or subsystem.
- Name the exact URL, file, or config location.
- Prefer exact key paths such as `email.smtpHost` over vague descriptions.
- If behavior changed recently, check `CHANGELOG.md` and state the version.
- If the docs are silent and you infer from code, say that clearly.

## Source Selection Hints

- Feature setup or runtime config:
  `https://hybridaione.github.io/hybridclaw/content/reference/configuration.md`, then `https://raw.githubusercontent.com/HybridAIOne/hybridclaw/main/config.example.json`
- Commands or operational workflows:
  `https://hybridaione.github.io/hybridclaw/content/reference/commands.md`
- Architecture or runtime behavior:
  `https://hybridaione.github.io/hybridclaw/content/agents.md`, then the relevant GitHub source URL if the docs are insufficient
- Release or migration questions:
  `https://raw.githubusercontent.com/HybridAIOne/hybridclaw/main/CHANGELOG.md`
- Workspace/bootstrap behavior:
  `https://raw.githubusercontent.com/HybridAIOne/hybridclaw/main/src/workspace.ts`, then the relevant template or GitHub source URL

## Guardrails

- Do not dump broad documentation when the user asked a narrow question.
- Do not cite stale knowledge if the repo has a fresher answer.
- Do not assume repo-local paths such as `src/` or `docs/content/` are readable from the current workspace.
- Do not browse unrelated files or URLs "just in case".
- Do not invent config keys, env vars, commands, or defaults.
- Do not defer to generic Gmail, SMTP, Google Workspace, or similar skills when
  the real question is how HybridClaw configures or uses those features.
- If multiple sources disagree, say so and prefer the implementation plus the newest docs.
