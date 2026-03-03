# openai.yaml Reference

`agents/openai.yaml` is optional UI metadata for skills.

## Minimal Example

```yaml
interface:
  display_name: "Skill Creator"
  short_description: "Create and maintain high-quality skills"
```

## Extended Example

```yaml
interface:
  display_name: "Skill Creator"
  short_description: "Create and maintain high-quality skills"
  icon_small: "./assets/skill-creator-small.svg"
  icon_large: "./assets/skill-creator.png"
  brand_color: "#0B6E4F"
  default_prompt: "Use $skill-creator to scaffold a new skill for release automation."
```

## Constraints

- Keep keys unquoted.
- Quote all string values.
- Keep `short_description` between 25 and 64 characters.
- For `default_prompt`, mention the skill explicitly as `$skill-name`.
- Use paths relative to the skill root for icon fields.

## Field Intent

- `display_name`: Human-facing skill title.
- `short_description`: One-line scan-friendly summary.
- `icon_small`: Small icon path.
- `icon_large`: Large icon path.
- `brand_color`: UI accent color in hex format.
- `default_prompt`: Suggested starter prompt for invoking the skill.
