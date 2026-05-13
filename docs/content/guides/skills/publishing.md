---
title: Publishing Skills
description: Diagram-as-code, Excalidraw diagrams, Manim and avatar video creation, Hermes3000 manuscripts, WordPress publishing, and blog post writing.
sidebar_position: 8
---

# Publishing Skills

## diagram

Create, validate, update, and render diagram-as-code artifacts through the
native `diagram_create`, `diagram_update`, and `diagram_validate` tools.
Mermaid is the default format, with PlantUML, Graphviz DOT, and Excalidraw JSON
available when the diagram shape or user request calls for them.

**Prerequisites** — none for source artifacts and SVG fallback previews. Install
or configure optional renderers for native exports: `mmdc` for Mermaid,
`dot` for Graphviz, and `HYBRIDCLAW_PLANTUML_SERVER_URL` for PlantUML.

> 💡 **Tips & Tricks**
>
> Pick the diagram type before writing Mermaid syntax: sequence, flowchart,
> state, ER, class, gantt, git-graph, mindmap, or pie.
>
> Run validation before rendering when you write or revise source manually.
>
> Use Graphviz for topology graphs, PlantUML for UML-heavy teams, and
> Excalidraw JSON when editability matters more than a static render.

> 🎯 **Try it yourself**
>
> `Create a Mermaid sequence diagram for a user request through gateway, container, and tool execution`
>
> `Validate this Mermaid flowchart source and fix any syntax errors before rendering it as SVG`
>
> `Create a Graphviz deployment topology for gateway, worker, SQLite, and Discord`

---

## image-generation

Generate or edit raster images through the native `image_generate` tool. The
runtime owns provider auth, provider quirks, artifact persistence, and media
delivery paths.

**Prerequisites** — configure at least one supported image provider and model
credential in the runtime environment or encrypted secret store.

> 💡 **Tips & Tricks**
>
> Use this skill for deliverable bitmap images. Use Excalidraw when the user
> needs an editable diagram.
>
> Include subject, composition, style, color, aspect ratio, and any exact text
> that must appear in the image.
>
> For edits, reference safe current-turn or workspace media paths rather than
> remote private URLs.

> 🎯 **Try it yourself**
>
> `Generate a 16:9 product launch header image for an AI operations dashboard`
>
> `Create a square social image for a webinar about secure AI workflows`
>
> `Restyle this uploaded image as a clean editorial illustration`

---

## video-generation

Generate short videos through the native `video_generate` tool. The runtime
handles provider selection, output persistence, warnings, and artifact delivery.

**Prerequisites** — configure at least one supported video provider and model
credential in the runtime environment or encrypted secret store.

> 💡 **Tips & Tricks**
>
> Use concise cinematic prompts with subject, movement, camera angle, duration,
> aspect ratio, lighting, and audio direction when the selected provider
> supports audio.
>
> Treat provider warnings as user-relevant when they change duration,
> resolution, or aspect ratio.

> 🎯 **Try it yourself**
>
> `Generate an 8-second product teaser showing a clean admin dashboard coming online`
>
> `Create a vertical video background for a launch announcement`
>
> `Make a 6-second cinematic clip of a secure server room with warm monitor light`

---

## video.from-script

Render approved avatar, voice, and script briefs into HeyGen MP4 videos with
async job polling and guarded credit-spend approval.

**Prerequisites** — store `HEYGEN_API_KEY` in HybridClaw encrypted runtime
secrets. Use the lower-level [`heygen`](./integrations.md#heygen) skill for
avatar, voice, and asset discovery.

> 💡 **Tips & Tricks**
>
> Use this when the script is final and the avatar/voice choices are known. Use
> `video-generation` for prompt-to-video providers such as Sora or Veo.
>
> Prefer `start` plus later `status` polling for long HeyGen renders. Use
> `render --wait` only when the user wants the agent to stay with the job.
>
> Run public marketing, sales, onboarding, or training scripts through
> `brand-voice` before starting a credit-consuming render.

> 🎯 **Try it yourself**
>
> `Plan a 60-second avatar video from this approved onboarding script using avatar avatar_123 and voice voice_123`
>
> `Start a HeyGen render for this approved sales follow-up script and return the job id`
>
> `Check the status of HeyGen job video_123 and download the MP4 if it is complete`

---

## manim-video

Plan, script, render, and stitch Manim Community Edition videos for animated
math explanations, algorithm walkthroughs, and 3Blue1Brown-style explainers.

**Prerequisites**

| Dependency | Purpose | Install |
|---|---|---|
| `python3` | Required runtime | System install |
| `manim` | Animation engine | `hybridclaw skill install manim-video manim` |
| `ffmpeg` | Video stitching | `hybridclaw skill install manim-video ffmpeg` |

> 💡 **Tips & Tricks**
>
> The skill targets educational cinema quality — geometry before algebra, breathing room for reveals, cohesive visual language.
>
> Write `plan.md` before coding `script.py` — the skill enforces this.
>
> Render drafts at `-ql` (low quality) for fast iteration, then `-qh` for final output.
>
> Three built-in color palettes: HybridClaw Dark, Light, and Neutral.

> 🎯 **Try it yourself**
>
> `Create a Manim video explaining how binary search works, step by step`
>
> `Animate the proof that the square root of 2 is irrational`
>
> `Render a visual walkthrough of Dijkstra's algorithm on a sample graph with 6 nodes`
>
> `Plan a 3-minute explainer on how hash tables work, write the Manim script with scenes for insertion, collision handling, and resizing, render a draft at low quality, and stitch the clips together`
>
> **Conversation flow:**
>
> `1. Plan a 2-minute Manim video explaining how a linked list works — cover node creation, insertion, traversal, and deletion`
> `2. Write the Manim script and render a low-quality draft of the first two scenes`
> `3. The insertion animation is too fast — slow it down to 2 seconds and re-render just that scene`

**Troubleshooting**

- **`manim` not found** — install via `hybridclaw skill install manim-video
  manim`.
- **Render errors** — check that `ffmpeg` is installed. Run draft renders at
  `-ql` first to catch issues before high-quality rendering.
- **Slow renders** — use `-ql` during development. Only render at `-qh` for
  final output.

---

## hermes3000-writing

Plan, draft, revise, and export durable long-form writing projects through the
Hermes3000 portal API.

**Prerequisites** — store `HERMES3000_EMAIL` and `HERMES3000_PASSWORD` in
HybridClaw encrypted runtime secrets. The skill captures and reuses
`HERMES3000_JWT` through gateway secret injection; the JWT is not printed or
returned to the agent.

> 💡 **Tips & Tricks**
>
> Use this for books, long reads, whitepapers, chapter outlines, world-building,
> consistency memory, and portal-managed exports.
>
> Keep author control explicit: confirm premise, audience, language, target
> length, genre or format, tone, and export format before creating durable
> portal content.
>
> Save accepted chapter drafts and update consistency memory before moving on
> to the next chapter.

> 🎯 **Try it yourself**
>
> `Create a Hermes3000 project plan for a 12-chapter nonfiction book about secure local AI operations`
>
> `Draft chapter 1 for the selected Hermes3000 project, then save it and update consistency memory`
>
> `Export the selected Hermes3000 manuscript as DOCX after checking chapter consistency`

---

## excalidraw

Create and revise editable `.excalidraw` diagrams for architecture diagrams,
flowcharts, sequence diagrams, concept maps, and hand-drawn explainers.

**Prerequisites** — none.

> 💡 **Tips & Tricks**
>
> Use Excalidraw JSON when the user needs an editable diagram instead of a
> rendered image.
>
> Keep labels as bound text elements, not custom properties on shapes.
>
> Use short stable ids and readable text sizes so future edits stay simple.

> 🎯 **Try it yourself**
>
> `Create an Excalidraw architecture diagram for a gateway, worker queue, database, and admin console`
>
> `Revise this .excalidraw file to add a retry path and error queue`
>
> `Make a hand-drawn flowchart for the support escalation process`

**Troubleshooting**

- **Diagram will not open** — validate that the file is valid JSON with the
  standard Excalidraw envelope.
- **Labels do not appear** — ensure labels are separate `text` elements bound
  to their shapes.

---

## wordpress

Draft posts and pages, coordinate wp-admin work, use WP-CLI, inspect themes or
plugins, and publish safely.

**Prerequisites**

| Dependency | Purpose | Install |
|---|---|---|
| `wp` (WP-CLI) | WordPress command-line management | `hybridclaw skill install wordpress wp` |

WP-CLI needs access to a WordPress installation (local or SSH).

> 💡 **Tips & Tricks**
>
> The skill always drafts content first, then publishes — never publishes directly.
>
> Confirm local vs staging vs production before any write operation.
>
> Use WP-CLI for bulk operations; use wp-admin for visual editing and plugin management.

> 🎯 **Try it yourself**
>
> `Draft a blog post titled "Introducing Smart Filters" announcing our new AI-powered search filters for the product catalog`
>
> `List all installed plugins and their update status`
>
> `Create a new page "Privacy Policy" as a draft covering data collection, cookie usage, third-party services, and GDPR contact info`
>
> `Check which plugins need updates, list them with current and available versions, draft a maintenance blog post announcing the updates, and save it as a draft scheduled for tomorrow at 9am`
>
> **Conversation flow:**
>
> `1. Draft a blog post titled "Announcing Dark Mode" covering what changed, why we built it, and how to enable it`
> `2. Add a "Before & After" section with placeholder image tags and a callout block for the keyboard shortcut`
> `3. Create a companion "What's New in April" page listing Dark Mode alongside two other fictional features, and save both as drafts`

**Troubleshooting**

- **WP-CLI not connecting** — verify `wp --info` works. Check that the
  WordPress install path is correct.
- **Permission denied on publish** — confirm you're working on the right
  environment (staging vs production).

---

## write-blog-post

Draft outlines and publish-ready blog posts tailored to audience, sources, and
voice.

**Prerequisites** — none.

> 💡 **Tips & Tricks**
>
> The skill confirms audience, tone, and core takeaway before drafting.
>
> Technical posts follow a different structure: problem, why it matters, approach, example, tradeoffs, conclusion.
>
> Strong openings: name the problem, offer a surprising insight, or use a before-and-after frame.
>
> Revision pass checks: does the title match the argument? Does every section earn its place?

> 🎯 **Try it yourself**
>
> `Write a blog post explaining why we migrated from a Django monolith to event-driven microservices, what broke along the way, and what we'd do differently`
>
> `Draft an outline for a post about "5 lessons from scaling to 1M users" — cover database sharding, CDN strategy, queue backpressure, feature flags, and on-call culture`
>
> `Write a 600-word thought-leadership piece arguing that AI-assisted code review catches more logic bugs than linting but creates a false sense of security around architecture decisions`
>
> `Research our last 3 product releases from the changelog, draft a year-in-review blog post highlighting the biggest improvements, include a section on what's coming next, and produce both the full post and a 280-character social media teaser`
>
> **Conversation flow:**
>
> `1. Draft an outline for a technical blog post about "How We Cut API Latency by 40%" targeting backend engineers`
> `2. Write the full post from the outline — include a problem section, the three optimizations we tried, benchmarks, and lessons learned`
> `3. Create a 280-character social media teaser and a 100-word newsletter blurb for the same post`
