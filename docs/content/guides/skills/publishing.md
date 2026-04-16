---
title: Publishing Skills
description: Manim video creation, WordPress publishing, and blog post writing.
sidebar_position: 8
---

# Publishing Skills

## manim-video

Plan, script, render, and stitch Manim Community Edition videos for animated
math explanations, algorithm walkthroughs, and 3Blue1Brown-style explainers.

**Prerequisites**

| Dependency | Purpose | Install |
|---|---|---|
| `python3` | Required runtime | System install |
| `manim` | Animation engine | `hybridclaw skill install manim-video uv-manim` |
| `ffmpeg` | Video stitching | `hybridclaw skill install manim-video brew-ffmpeg` |

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
  uv-manim`.
- **Render errors** — check that `ffmpeg` is installed. Run draft renders at
  `-ql` first to catch issues before high-quality rendering.
- **Slow renders** — use `-ql` during development. Only render at `-qh` for
  final output.

---

## wordpress

Draft posts and pages, coordinate wp-admin work, use WP-CLI, inspect themes or
plugins, and publish safely.

**Prerequisites**

| Dependency | Purpose | Install |
|---|---|---|
| `wp` (WP-CLI) | WordPress command-line management | `hybridclaw skill install wordpress brew-wp-cli` |

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
