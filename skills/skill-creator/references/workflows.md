# Skill Authoring Workflows

This document captures reusable workflows for creating and iterating skills.

## Workflow A: New Skill From Scratch

Use when no existing skill folder exists.

1. Define trigger scenarios.
2. Define the minimal command contract.
3. Initialize scaffold with `scripts/init_skill.py`.
4. Implement scripts/references/assets.
5. Write `SKILL.md` last, using links to references.
6. Validate with `scripts/quick_validate.py`.
7. Package with `scripts/package_skill.py` if sharing.

Exit criteria:

- Trigger description is explicit and testable.
- Script paths and command examples are correct.
- Validation passes with no warnings.

## Workflow B: Improve Existing Skill

Use when refactoring or extending a current skill.

1. Collect failing or weak real-world prompts.
2. Identify gaps: trigger mismatch, missing script, unclear guidance.
3. Patch only the smallest set of files needed.
4. Re-run validation and representative script tests.
5. If distribution format matters, rebuild package and re-test.

Exit criteria:

- Previously weak prompts now route correctly.
- No regressions in existing commands.

## Workflow C: Multi-Variant Skill

Use when one skill supports multiple providers/frameworks.

1. Keep provider selection logic in `SKILL.md`.
2. Split provider specifics into separate reference files.
3. Link all variants directly from `SKILL.md`.
4. Keep per-variant examples in variant reference files.

Recommended layout:

```text
my-skill/
  SKILL.md
  references/
    provider-a.md
    provider-b.md
    provider-c.md
```

## Workflow D: Script-First Stabilization

Use when outputs are drifting across runs.

1. Move fragile steps into script(s).
2. Keep script interfaces simple and explicit.
3. Document input/output contract in `SKILL.md`.
4. Add regression tests for script behavior.

## Review Gates

Apply these gates before completion:

1. Trigger gate: frontmatter includes clear activation cues.
2. Brevity gate: `SKILL.md` is concise and avoids deep internals.
3. Determinism gate: critical paths use scripts or strict command sequences.
4. Safety gate: packaging/test paths reject unsafe archives.
5. UX gate: `agents/openai.yaml` values are user-friendly and aligned.

## Troubleshooting

### Skill does not trigger

- Make frontmatter description more concrete.
- Add key user phrases and task contexts.
- Remove generic wording that applies to many skills.

### Skill triggers too often

- Narrow the description to explicit task boundaries.
- Reduce overlap with neighboring skills by naming clear exclusions.

### Skill gets too large

- Move deep content to `references/`.
- Replace long prose with command snippets and short decision rules.

### Script behavior differs by environment

- Pin interpreter (`python3`) in examples.
- Validate path handling and file encoding assumptions.
- Add representative tests for platform-sensitive behavior.
