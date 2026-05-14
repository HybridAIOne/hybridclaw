---
name: diagram
description: Create, validate, update, and render diagram-as-code artifacts with Mermaid-first schema awareness plus PlantUML, Graphviz DOT, and Excalidraw JSON adapters.
user-invocable: true
disable-model-invocation: false
metadata:
  hybridclaw:
    category: publishing
    short_description: "Validated diagram-as-code artifacts."
    tags:
      - diagram
      - mermaid
      - plantuml
      - graphviz
      - excalidraw
      - visualization
    related_skills:
      - excalidraw
      - manim-video
      - write-blog-post
---

# Diagram

Use this skill when the user wants a rendered static diagram, a validated diagram source artifact, or a revision to an existing diagram source.

Default to Mermaid unless the user asks for another format or the shape is a better fit for another adapter:

- Mermaid: sequence, flowchart, state, ER, class, gantt, git-graph, mindmap, and pie diagrams.
- PlantUML: UML sequence/component/activity/deployment diagrams when the user already uses PlantUML or asks for it.
- Graphviz DOT: topology, dependency graphs, and layouts where rank/direction control matters.
- Excalidraw JSON: hand-drawn-style editable sketches when the user asks for an editable canvas.

## Tool Surface

Use the runtime tools directly:

- `diagram_create`: create source, validate it, save source, and optionally render.
- `diagram_update`: update existing source or source artifact, validate it, save a new source artifact, and optionally render.
- `diagram_validate`: validate source only; do not render.

The tool output includes these fields:

```json
{
  "success": true,
  "valid": true,
  "source": "...",
  "source_artifact_ref": "/workspace/.generated-diagrams/skills/diagram/diagram-...",
  "rendered_artifact_ref": "/workspace/.generated-diagrams/skills/diagram/diagram-...",
  "type": "flowchart",
  "format": "mermaid",
  "artifacts": [],
  "runtime_events": [],
  "warnings": []
}
```

On validation failure, `success` and `valid` are false and `errors` plus
`suggested_fix` may be present. When `render_to` is `"none"`,
`rendered_artifact_ref` is `null`. Invalid source is still saved with
`source_artifact_valid: false` so the operator can inspect or repair it.

## Default Workflow

1. Pick the diagram type before writing syntax. If uncertain, set `type` to `auto`, but prefer an explicit type when the user request clearly names one.
2. For Mermaid, read [references/mermaid-types.md](references/mermaid-types.md) when you need grammar examples or when the diagram type is not obvious.
3. Draft complete source yourself when the user needs a specific diagram. Do not rely on the tool's generated starter unless the request is generic.
4. Call `diagram_validate` before rendering when you wrote or revised source manually.
5. If validation fails, use the returned `errors` and `suggested_fix`, revise once, then validate again. Make at most 2 fix-up attempts before surfacing the failure with the invalid source artifact. The runtime also caps automatic pre-render fix-up at 2 attempts.
6. Call `diagram_create` or `diagram_update` with `render_to` set to `svg` by default. Use `png` or `pdf` only when requested and the adapter can render that target.
7. Return the source artifact and rendered artifact paths to the user.

## Type Selection

Use these defaults:

| User intent | Type |
| --- | --- |
| messages, API call flow, actors, request/response | `sequence` |
| process, decision tree, pipeline, system flow | `flowchart` |
| lifecycle, status machine, transitions | `state` |
| database schema, entities, relationships | `er` |
| classes, interfaces, inheritance, methods | `class` |
| timeline, schedule, milestones, roadmap | `gantt` |
| branches, commits, merges, release train | `git-graph` |
| brainstorm, taxonomy, concept map, outline | `mindmap` |
| shares, proportions, percentages | `pie` |

## Mermaid Rules

- Use the canonical header for the selected type.
- Keep labels short and ASCII-safe unless the user provided exact labels.
- Quote labels when Mermaid grammar requires it, especially pie chart slices.
- Avoid unsupported Markdown inside labels.
- Prefer `flowchart TD` or `flowchart LR`; do not mix both in one source.
- In `sequenceDiagram`, define participants when names are long or reused.
- In `gantt`, include `dateFormat` and stable task ids when using dependencies.
- In `erDiagram`, include cardinality on relationships.

## Update Rules

For `diagram_update`, preserve the existing `type` and `format` unless the user explicitly asks to convert. When the user gives natural-language update instructions:

1. Read the existing source artifact when needed.
2. Apply the change to the source yourself.
3. Validate the full updated source.
4. Call `diagram_update` with the complete updated source, original format/type, and desired `render_to`.

If the user only asks to annotate a diagram and exact placement does not matter, the tool can add a small update annotation when passed only `artifact_ref` plus `instructions`.

## Adapter Notes

- Mermaid and Graphviz use local renderers when available. If a renderer is not installed, SVG requests fall back to source-backed SVG artifacts so the operator still gets an embed-ready file.
- Mermaid validation uses the bundled Mermaid parser before rendering, so syntax errors are surfaced even when `mmdc` is not installed.
- PlantUML rendering uses `HYBRIDCLAW_PLANTUML_SERVER_URL` or `PLANTUML_SERVER_URL` when configured. Without a server, SVG requests fall back to source-backed SVG artifacts. Operators are responsible for pointing this setting only at a trusted PlantUML server with appropriate network egress controls.
- Excalidraw defaults to `render_to: "none"` because JSON is the editable deliverable. Use `render_to: "svg"` when a static preview is requested; the runtime renders the JSON elements directly to SVG.
- Local Mermaid and Graphviz renders use short-lived OS temp directories. Normal tool completion removes them; process-level termination such as SIGKILL may leave temporary source copies for the OS temp cleaner.
Diagram render usage is reported as a zero-cost budget hook; LLM tokens are only consumed when the model drafts or repairs source.

## Runtime Hooks

Rendered diagrams include a `diagram.rendered` event in `runtime_events`.
Validation failures include a `diagram.validation_failed` event with the
validation errors and source artifact path when one was persisted. Diagram
artifacts are stored under the skill-scoped path
`.generated-diagrams/skills/diagram/`.

## Stakes

Diagram rendering is F8 low stakes: the output is a file artifact the operator chooses to share. Do not treat generated diagrams as authoritative for security, legal, medical, or financial decisions without separate verification.
