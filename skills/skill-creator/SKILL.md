---
name: skill-creator
description: "Create and update SKILL.md-based skills with strong trigger metadata, lean docs, and reliable init, validate, package, and publish workflows."
user-invocable: true
disable-model-invocation: false
metadata:
  hybridclaw:
    category: development
    short_description: "Create and update skills."
---
# Skill Creator

Build high-quality skills that are clear to trigger, cheap in context, and reliable in execution.

## Core Principles

### 1) Concise is a hard requirement

Assume the model already knows general concepts. Include only information that improves outcomes for this specific skill.

- Prefer short imperative instructions over essays.
- Keep essential workflow in `SKILL.md`.
- Move deep detail into `references/`.

### 2) Set the right degrees of freedom

Pick guidance strictness by task fragility:

- High freedom: heuristics and decision rules.
- Medium freedom: parameterized scripts and pseudocode.
- Low freedom: exact commands and narrow steps.

Use low freedom when consistency and safety matter; allow higher freedom when multiple valid approaches exist.

### 3) Design for progressive disclosure

Skills should load in layers:

1. Frontmatter `name` + `description` (always loaded)
2. `SKILL.md` body (loaded on trigger)
3. `references/`, `scripts/`, `assets/` (loaded only when needed)

Target sizes:

- `SKILL.md` body: 1,500-2,000 words
- `references/*`: 2,000-5,000+ words when needed
- Keep `SKILL.md` under ~500 lines; split earlier if it grows fast

## Anatomy of a Skill

Required:

- `SKILL.md`
- YAML frontmatter with `name`, `description`, and a top-level `category`

Recommended:

- `agents/openai.yaml` for UI-facing metadata

Optional:

- `scripts/` for deterministic or repeated operations
- `references/` for deep guidance and domain details
- `assets/` for templates/images/files used in outputs
- `license.txt` when sharing externally

## What Goes Where

Use this taxonomy to keep skills maintainable:

- `SKILL.md`: trigger semantics, decision flow, command contract, minimal examples
- Frontmatter `category`: short top-level bucket like `development`, `office`, `apple`, or `memory`
- `references/`: long docs, schemas, framework variants, advanced patterns
- `scripts/`: executable deterministic helpers
- `assets/`: output resources that should not be read into context by default

Keep references one level deep from `SKILL.md` links. Avoid deep reference chains.

## What Not to Include

Do not add process clutter that does not improve runtime behavior, such as:

- `README.md`
- `CHANGELOG.md`
- installation how-to docs for humans only
- duplicate copies of instructions already in `SKILL.md`

Keep only files that help another agent execute the task.

## Skill Discovery Notes

Many runtimes resolve skills from multiple roots. Document your effective precedence so users know where overrides win.

Common locations:

- `./skills/<skill>/SKILL.md` (workspace)
- `./.agents/skills/<skill>/SKILL.md` (project-local)
- `~/.agents/skills/<skill>/SKILL.md` (user-level)
- `~/.claude/skills/<skill>/SKILL.md` (user-level)
- `~/.codex/skills/<skill>/SKILL.md` (user-level)
- bundled/package-managed skill directories (environment-specific)

If precedence differs in your runtime, state the exact order in project docs and keep this skill focused on authoring quality.

## Skill Creation Workflow

Follow this sequence unless there is a clear reason to skip a step.

### Step 1: Gather concrete usage examples

Identify 3-6 realistic prompts that should trigger the skill.

Ask focused questions, for example:

- What user requests should activate this skill?
- What should this skill handle directly vs defer?
- Which file types, tools, or APIs are in scope?

### Step 2: Plan reusable artifacts

For each example, identify repeatable parts and place them in the right resource type.

Examples:

- Repeated code logic -> `scripts/*.py`
- Domain rules/schemas -> `references/*.md`
- Starter templates -> `assets/`

### Step 3: Initialize scaffold

Use the initializer for consistent structure:

```bash
python3 scripts/init_skill.py <skill-name> --path <skills-dir> --resources scripts,references,assets
```

For UI metadata, provide deterministic interface values:

```bash
python3 scripts/init_skill.py <skill-name> --path <skills-dir> \
  --interface display_name="..." \
  --interface short_description="..." \
  --interface default_prompt="Use $<skill-name> to ..."
```

### Step 4: Implement and refine

1. Build scripts and references first.
2. Write `SKILL.md` as an execution guide, not an essay.
3. Link to references only where decisions require them.
4. Delete placeholder/example files that are not used.

### Step 5: Validate

Run structural and metadata checks:

```bash
python3 scripts/quick_validate.py <path/to/skill>
```

If UI metadata is used, regenerate and compare:

```bash
python3 scripts/generate_openai_yaml.py <path/to/skill>
```

### Step 6: Package and test (if distributing)

Create a `.skill` archive with path and symlink safety checks:

```bash
python3 scripts/package_skill.py <path/to/skill>
```

Run packaging regression tests:

```bash
python3 scripts/test_package_skill.py
```

## Writing Style Guide

Use imperative voice and explicit constraints.

Good:

- "Run `python3 scripts/quick_validate.py <skill-dir>` before packaging."
- "Load `references/aws.md` only when the selected provider is AWS."

Weak:

- "You might want to validate things eventually."
- "Read all references first."

Prefer:

- specific commands
- bounded scope
- clear success conditions

Avoid:

- vague phrases without operational meaning
- duplicated instructions in multiple files
- large inline reference dumps in `SKILL.md`

## Validation Checklist

Before calling a skill complete, verify:

1. Frontmatter `description` clearly states what it does and when to use it.
2. Skill name is lowercase hyphen-case and <= 64 characters.
3. `SKILL.md` contains concise workflow guidance and links to deep docs.
4. Scripts execute successfully on representative inputs.
5. `quick_validate.py` passes.
6. Packaging (if needed) rejects unsafe paths and symlinks.
7. `agents/openai.yaml` is present and aligned when UI metadata is required.

## Common Mistakes

- Putting trigger conditions only in the body instead of frontmatter.
- Keeping large variant-specific details in `SKILL.md` instead of `references/`.
- Shipping untested scripts.
- Leaving template placeholders in production skills.
- Including docs that explain creation process instead of runtime execution.

## Review Workflow

Run a second pass focused on execution quality:

1. Simulate real user prompts.
2. Check whether the skill triggers correctly.
3. Confirm instructions are sufficient without hidden assumptions.
4. Tighten wording where ambiguity causes drift.

Use `references/workflows.md` and `references/output-patterns.md` for reusable review patterns and output contracts.
