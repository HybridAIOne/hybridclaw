# Output Patterns for Skill Creator

Use these patterns when the user asks for plans, scaffolds, or review output.

## Pattern 1: Skill Design Spec

Use before implementation.

```markdown
Skill design:
- Name: <hyphen-case>
- Trigger description: <frontmatter description draft>
- Scope: <in-scope tasks>
- Exclusions: <out-of-scope tasks>

Resources:
- scripts/: <list>
- references/: <list>
- assets/: <list or none>

Validation plan:
1. <check>
2. <check>
3. <check>
```

## Pattern 2: Scaffold Result

Use after running initializer.

```markdown
Created:
- <absolute path>/SKILL.md
- <absolute path>/agents/openai.yaml
- <absolute path>/scripts/...

Next edits:
1. Fill frontmatter description with trigger phrases.
2. Replace placeholder sections in SKILL.md.
3. Add deterministic scripts for repeated operations.
4. Run quick validation.
```

## Pattern 3: Validation Report

Use after `quick_validate.py`.

```markdown
Validation result: PASS|FAIL

Checks:
- Frontmatter parsed: PASS|FAIL
- Required keys: PASS|FAIL
- Name constraints: PASS|FAIL
- Description constraints: PASS|FAIL
- Optional metadata checks: PASS|FAIL

Issues:
1. <error and file>
2. <error and file>

Recommended fixes:
1. <specific fix>
2. <specific fix>
```

## Pattern 4: Packaging Report

Use after `package_skill.py`.

```markdown
Packaging result: PASS|FAIL
Archive: <path or none>
Files included: <count>

Safety checks:
- Symlink rejection: PASS|FAIL
- Path traversal prevention: PASS|FAIL
- Root containment: PASS|FAIL

Notes:
- <compatibility or follow-up details>
```

## Pattern 5: Iteration Summary

Use after improving an existing skill.

```markdown
Iteration summary:
- Trigger quality improved by: <what changed>
- Structure changes: <files moved/split>
- Script changes: <new or updated scripts>
- Validation status: PASS|FAIL
- Regression status: PASS|FAIL

Residual risks:
1. <risk>
2. <risk>
```

## Pattern 6: Quality Review Findings

Use for review-oriented requests.

```markdown
Findings:
1. [High] <file>:<line> - <problem>
2. [Medium] <file>:<line> - <problem>
3. [Low] <file>:<line> - <problem>

Open questions:
1. <question>

Change summary:
- <one-line summary>
```

Keep findings specific, severity-ranked, and mapped to exact files.
