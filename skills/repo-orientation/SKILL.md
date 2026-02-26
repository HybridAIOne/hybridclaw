---
name: repo-orientation
description: Quickly map an unfamiliar repository and identify where a requested feature should be implemented.
user-invocable: true
disable-model-invocation: false
---

# Repo Orientation

Use this skill when the user asks where code lives, how a feature works, or where to make a change in an unfamiliar repo.

## Tooling Notes

- Prefer `glob` + `grep` first. They are cheaper and more reliable than broad shell exploration.
- Use `read` sparingly for small/high-value files only.
- Keep the whole run under about 8 tool calls.

## Workflow

1. Establish top-level structure with `glob`.
Run:
```json
{"pattern":"*"}
```

2. Build a focused file map with `glob`.
Run one or two targeted globs, not many:
```json
{"pattern":"src/**/*"}
{"pattern":"test/**/*"}
{"pattern":"docs/**/*"}
```

3. Find likely implementation points by keyword with `grep`.
Run:
```json
{"pattern":"<keyword|feature|command|route|tool>","path":"src"}
```
If needed, repeat for one extra directory (`test` or `docs`).

4. Read only the most relevant files (max 3 reads).
Prioritize:
- entrypoints (`src/index.*`, `src/main.*`, `src/cli.*`)
- docs (`README.md`, `CLAUDE.md`, `AGENTS.md`)
- files returned by search in step 3

5. Return a concise map immediately.
Include:
- probable files to edit
- related files to verify
- risks/regressions to check

## Output Template

Use this exact structure:

```markdown
Feature map:
- Primary file(s):
- Supporting file(s):
- Tests to update:

Why these files:
- ...

Proposed first edit:
- ...
```

## Constraints

- Do not keep scanning once you have a plausible file map.
- Do not read large unrelated files "just in case."
- If confidence is low, state assumptions and list the next command to disambiguate.
