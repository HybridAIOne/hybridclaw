---
title: Skills Catalog
description: Per-skill reference with descriptions, prerequisites, installation, tips, example prompts, and troubleshooting.
sidebar_position: 5
---

# Skills Catalog

HybridClaw ships **34 bundled skills**. This page is the per-skill reference.
For CLI management commands see [Bundled Skills](./bundled-skills.md); for
resolution rules and runtime internals see
[Skills Internals](../extensibility/skills.md).

> **Quick install pattern** — most skills work out of the box. When a skill
> needs a host-side dependency, install it with:
>
> ```bash
> hybridclaw skill install <skill> <dependency-id>
> ```

---

## Office

### pdf

Extract text, render pages, inspect or fill forms, and overlay content on PDFs
with bundled Node/JS tools.

**Prerequisites**

| Dependency | Purpose | Install |
|---|---|---|
| `poppler` | PDF-to-image rendering (`pdftoppm`) | `hybridclaw skill install pdf brew-poppler` |
| `qpdf` | PDF merging, splitting, linearization | `hybridclaw skill install pdf brew-qpdf` |

Both are optional — the skill degrades gracefully without them.

**Tips & Tricks**

- The skill ships bundled Node scripts under `skills/pdf/scripts/` — prefer
  them over external CLIs.
- For invoice extraction, let the skill try text extraction first; it falls back
  to page rendering and vision only when text is unusable.
- Use `--format json` on extraction scripts when you need structured downstream
  processing.

**Use Cases & Example Prompts**

- `Extract the text from invoice.pdf and list all line items with totals`
- `Fill the "Name" and "Date" fields in application-form.pdf and save as filled.pdf`
- `Merge report-q1.pdf and report-q2.pdf into combined-report.pdf`
- `Render page 3 of blueprint.pdf as a PNG so I can inspect the diagram`
- `Check if contract.pdf has fillable form fields`

**Troubleshooting**

- **"Cannot find module"** — ensure `node` is available on PATH. The pdf skill
  is Node-only; it does not use Python.
- **Blank text extraction** — the PDF may be image-based (scanned). The skill
  does not include OCR; render pages to PNG and use vision tooling instead.
- **Missing `pdftoppm`** — install Poppler via the command above. Without it,
  page-to-image rendering is unavailable.

---

### xlsx

Create, edit, inspect, and analyze `.xlsx` spreadsheets and Excel workbooks
using bundled Node scripts and `xlsx-populate`.

**Prerequisites**

| Dependency | Purpose | Install |
|---|---|---|
| `node` | Required runtime | System install |
| LibreOffice (optional) | Formula recalculation and format conversion | See [Office Dependencies](./office-dependencies.md) |

**Tips & Tricks**

- Use the bundled `create_xlsx.cjs` for quick creation from headers + rows or
  JSON data.
- `xlsx-populate` does **not** auto-recalculate formulas — run `recalc.cjs`
  with LibreOffice after formula edits.
- For CSV/TSV imports, use the bundled `import_delimited.cjs` instead of manual
  parsing.
- Prefer `.xlsx` as the final deliverable; convert from CSV only as an
  intermediate step.

**Use Cases & Example Prompts**

- `Create a spreadsheet from this JSON data with headers "Name", "Revenue", "Quarter"`
- `Add a SUM formula to column D in sales.xlsx and recalculate`
- `Import transactions.csv into an xlsx with proper column formatting`
- `Read the first sheet of budget.xlsx and summarize the top 5 expense categories`
- `Build a financial model spreadsheet with revenue projections for 12 months`

**Troubleshooting**

- **Formulas show stale values** — `xlsx-populate` cannot recalculate. Run
  `recalc.cjs` (requires LibreOffice) or open the file in Excel/Sheets.
- **`node` not found** — install Node.js (v18+) on the host.
- **Large file performance** — for workbooks over ~50 MB, consider splitting
  into multiple sheets or files.

---

### docx

Create, inspect, and edit `.docx` files safely, including comments and
OOXML-preserving changes.

**Prerequisites**

| Dependency | Purpose | Install |
|---|---|---|
| `node` | Required runtime | System install |
| `pandoc` (optional) | Markdown-to-DOCX conversion | `brew install pandoc` |

**Tips & Tricks**

- For **new documents**, write Markdown first and convert with `pandoc` — it is
  faster and produces cleaner output than programmatic generation.
- For **existing documents**, use the OOXML unpack-edit-repack workflow to
  preserve original formatting.
- Always escape XML-sensitive characters (`&`, `<`, `>`) when editing raw
  OOXML.
- Prefer user-provided `.docx` templates over generating from scratch.

**Use Cases & Example Prompts**

- `Create a professional project proposal document from this outline`
- `Add a comment to paragraph 3 of report.docx saying "Needs updated figures"`
- `Convert my notes.md into a formatted Word document with a table of contents`
- `Extract all tracked changes from review.docx and list them`
- `Update the header in template.docx to say "Q2 2026 Report"`

**Troubleshooting**

- **Corrupted output after edit** — relationship IDs likely drifted. Keep
  `_rels/*.rels` consistent when adding or removing OOXML parts.
- **Formatting lost** — if you used `pandoc` on an existing file, switch to
  OOXML editing to preserve the original styles.

---

### pptx

Create and edit `.pptx` presentations, export thumbnails for QA, and build
polished decks with pptxgenjs plus OOXML editing.

**Prerequisites**

| Dependency | Purpose | Install |
|---|---|---|
| `node` | Required runtime | System install |
| LibreOffice (optional) | Thumbnail export for visual QA | See [Office Dependencies](./office-dependencies.md) |

**Tips & Tricks**

- **New decks** → use `pptxgenjs` from a CommonJS `.cjs` script.
- **Template edits** → unpack the `.pptx`, edit the OOXML XML parts, repack.
  Never round-trip a template through pptxgenjs.
- Use the visual QA loop: export to PDF → render thumbnails → inspect → fix.
- One clear message per slide keeps presentations focused.

**Use Cases & Example Prompts**

- `Create a 10-slide pitch deck about our product launch from this brief`
- `Update the title slide in template.pptx with our new company name and logo`
- `Convert this quarterly data into a presentation with charts on each slide`
- `Add speaker notes to every slide in workshop.pptx`
- `Export all slides as PNG thumbnails so I can review the layout`

**Troubleshooting**

- **Broken slide after template edit** — use OOXML unpack/repack, not
  pptxgenjs, for existing templates.
- **Missing thumbnails** — the visual QA loop requires LibreOffice and
  `pdftoppm` (Poppler). Install both via [Office Dependencies](./office-dependencies.md).

---

### office-workflows

Coordinate cross-format office workflows across CSV/TSV, XLSX, DOCX, and PPTX
deliverables. This skill orchestrates the other office skills.

**Prerequisites** — none beyond what the individual office skills require.

**Tips & Tricks**

- Use chain mode when later outputs depend on prior findings (e.g.,
  XLSX → analysis → PPTX summary).
- Use parallel mode for independent research branches.
- Always produce fresh outputs from source files rather than editing
  previously generated artifacts.

**Use Cases & Example Prompts**

- `Import sales.csv into xlsx, add a summary sheet, then create a 5-slide pptx deck from the highlights`
- `Analyze the data in report.xlsx and write a one-page executive memo as docx`
- `Take these three CSVs, merge them into one xlsx, and generate a presentation with key charts`

---

## Development

### code-review

Review diffs and change sets for bugs, regressions, risks, and missing tests.

**Prerequisites** — `git`, optionally `gh` (GitHub CLI) for PR reviews.

**Tips & Tricks**

- The skill reviews by severity: incorrect logic → auth/secret mistakes →
  missing validation → risky coupling → flaky tests.
- It searches for leftover `console.log`, `TODO`, `FIXME`, passwords, and
  tokens automatically.
- For GitHub PRs, it uses `gh pr view` and checks CI status.

**Use Cases & Example Prompts**

- `Review the diff on my current branch for bugs and security issues`
- `Review PR #42 and list findings by severity`
- `Check the last 3 commits for regressions against the test suite`
- `Look at the changes in src/auth/ and flag anything risky`

**Troubleshooting**

- **`gh` not authenticated** — run `gh auth login` before PR reviews.
- **Large diffs** — the skill reads changed files individually; very large
  PRs may take longer.

---

### github-pr-workflow

Create branches, commit and push changes, open or update GitHub pull requests,
handle CI, and merge safely.

**Prerequisites** — `git`, `gh` (GitHub CLI, authenticated).

**Tips & Tricks**

- The skill follows a fixed sequence: sync base → branch → implement → commit
  → push → open PR → watch CI → address feedback → merge.
- Prefer small, focused PRs. If stacking PRs, make the dependency explicit.
- Use `gh pr checks --watch` to wait for CI to finish.

**Use Cases & Example Prompts**

- `Create a new branch, implement the fix, and open a PR against main`
- `Push my current changes and open a draft PR with a summary`
- `Check CI status on my open PR and fix any failures`
- `Address the review comments on PR #55 and push an update`
- `Merge PR #55 once CI is green and it has an approval`

**Troubleshooting**

- **Push rejected** — likely need to `git pull --rebase` first.
- **CI fails** — the skill will attempt to read failure logs and fix locally
  before re-pushing.

---

### salesforce

Inspect Salesforce objects, fields, relationships, Tooling API metadata, and
SOQL rows with a bundled Python helper. Read-only by default.

**Prerequisites**

| Dependency | Purpose | Install |
|---|---|---|
| `python3` | Required runtime | System install |
| Salesforce credentials | Stored secrets: `SF_FULL_USERNAME`, `SF_FULL_PASSWORD`, `SF_FULL_CLIENTID`, `SF_FULL_SECRET`, `SF_DOMAIN` | Configure via HybridClaw secrets |

**Tips & Tricks**

- Always run `objects` or `describe` before writing SOQL against unfamiliar
  objects.
- Use `relations` to discover join paths between objects.
- Add `LIMIT` to queries on large tables to avoid timeouts.
- The helper uses `<secret:NAME>` placeholders resolved server-side — secrets
  never touch disk.

**Use Cases & Example Prompts**

- `List all Salesforce objects that contain "Account" in the name`
- `Describe the fields on the Opportunity object`
- `Query the 10 most recent Contacts with their Account names`
- `Show me the relationships between Case and Account`
- `Run a Tooling API query to find all Apex classes modified this week`

**Troubleshooting**

- **Authentication errors** — verify all five stored secrets are set and
  `SF_DOMAIN` is `login` (production) or `test` (sandbox).
- **SOQL query fails** — check field API names with `describe` first; display
  labels differ from API names.

---

### skill-creator

Create and update `SKILL.md`-based skills with strong trigger metadata, lean
docs, and reliable init/validate/package/publish workflows.

**Prerequisites** — none.

**Tips & Tricks**

- Follow the three-layer model: frontmatter (triggers + metadata) → SKILL.md
  body (core workflow) → references/scripts/assets (detail).
- Keep SKILL.md concise — the model already knows general concepts; only
  include what is unique to your skill.
- Use `quick_validate.py` to check your skill before publishing.

**Use Cases & Example Prompts**

- `Create a new skill called "brand-voice" that enforces our writing style guide`
- `Add a brew dependency for imagemagick to the manim-video skill`
- `Validate the frontmatter and structure of my custom skill`
- `Package the skill in ./my-skills/seo-audit for sharing`

---

### code-simplification

*(Model-invoked, not user-invocable)*

Refactors code to reduce complexity and duplication without changing behavior.
Activated automatically during code-review and refactoring workflows. Moves
include: nested ifs → early returns, extract helpers, inline dead wrappers,
split data gathering from side effects.

---

## Communication

### discord

Read, send, react to, edit, pin, and thread Discord messages using HybridClaw's
built-in `message` tool.

**Prerequisites** — HybridClaw must be connected to a Discord server
(see [Discord Channel Setup](../channels/discord.md)).

**Tips & Tricks**

- Always use explicit numeric IDs for guilds, channels, and messages.
- Read the channel first, then act — avoids duplicate sends and stale context.
- No markdown tables in Discord — they don't render. Use code blocks or lists
  instead.
- Confirm before bulk operations (mass-posting, deleting).

**Use Cases & Example Prompts**

- `Read the last 20 messages in #general`
- `Send "Deploy complete ✅" to #deployments`
- `React with 👍 to the last message in #approvals`
- `Create a thread on the last message in #bugs titled "Login issue investigation"`
- `Pin the announcement about the maintenance window in #ops`

**Troubleshooting**

- **"Unknown channel"** — double-check the channel ID. Use guild/channel
  inspection to list available channels.
- **Message not sending** — verify bot permissions in the target channel.

---

### channel-catchup

Summarize recent activity across Discord, ingested email threads, WhatsApp, and
TUI channels.

**Prerequisites** — at least one channel connected.

**Tips & Tricks**

- The skill defaults to the broadest safe scope — no need to specify every
  channel unless you want to narrow down.
- It leads with actionable updates and separates facts from significance.
- Default limits: Discord last 50 messages, Email last 20 threads.

**Use Cases & Example Prompts**

- `What happened while I was away?`
- `Catch me up on #engineering from the last 24 hours`
- `Summarize today's email threads`
- `Give me a catch-up across all channels since yesterday morning`

---

## Apple

> These skills require **macOS** and use `osascript` / native apps.

### apple-calendar

View Apple Calendar schedules, draft or import `.ics` files, and coordinate
calendar actions on macOS.

**Prerequisites** — macOS with Calendar.app. Optionally `icalBuddy`
(`brew install ical-buddy`) for CLI calendar queries.

**Tips & Tricks**

- The skill generates portable `.ics` files by default — they work with any
  calendar app, not just Apple Calendar.
- Always confirm event details (time, timezone, attendees) before creating.
- For recurring events, describe the pattern in natural language — the skill
  handles RRULE generation.

**Use Cases & Example Prompts**

- `What's on my calendar for tomorrow?`
- `Create an ICS file for a team standup every weekday at 9:30am`
- `Show me all meetings this week with "Design" in the title`
- `Draft a calendar invite for a project kickoff next Monday at 2pm`

**Troubleshooting**

- **No events returned** — `icalBuddy` may not be installed, or Calendar.app
  has no accounts configured. Check with `icalBuddy -n eventsToday`.

---

### apple-music

Control Apple Music playback, inspect now playing, start playlists, and automate
the macOS Music app.

**Prerequisites** — macOS with Music.app.

**Tips & Tricks**

- Transport commands (play, pause, skip) work instantly via `osascript`.
- For specific songs or playlists, the skill uses bundled helper scripts
  (`play-url.sh`, `search.sh`).
- Use the Music URL workflow (`music://`) for direct deep links.

**Use Cases & Example Prompts**

- `What song is playing right now?`
- `Skip to the next track`
- `Play my "Focus" playlist`
- `Search Apple Music for "Beethoven Symphony No. 9" and play it`
- `Pause the music`

---

### apple-passwords

Open macOS Passwords or Keychain entries, locate saved logins, and read specific
credentials safely.

**Prerequisites** — macOS with Passwords.app (Sequoia+) or Keychain Access.

**Tips & Tricks**

- The skill prioritizes metadata lookup before revealing any secret.
- Passwords are never printed unless you explicitly ask.
- Use the GUI (Passwords.app) when multiple matches exist for easier selection.

**Use Cases & Example Prompts**

- `Open the Passwords app`
- `Find my saved login for github.com`
- `What accounts do I have stored in Keychain for "aws"?`
- `Show me the password for my Netflix account`

---

## Productivity

### feature-planning

Break features into implementation plans, acceptance criteria, and sequenced
tasks.

**Prerequisites** — none.

**Tips & Tricks**

- The skill inspects current code paths, types, and tests before planning.
- Task definitions include exact file paths and verification commands.
- Risky/uncertain work is sequenced first to surface blockers early.

**Use Cases & Example Prompts**

- `Plan the implementation of a user notification system`
- `Break down the migration from REST to GraphQL into tasks`
- `Create an implementation plan for adding dark mode with acceptance criteria`
- `What's the safest sequence to refactor the auth middleware?`

---

### project-manager

Plan sprints, milestones, roadmaps, risks, dependencies, and stakeholder
updates for team delivery.

**Prerequisites** — none.

**Tips & Tricks**

- Outputs include: implementation plans, milestone tables, risk registers,
  sprint plans, stakeholder updates, dependency maps.
- Estimates are always labeled as assumptions.
- Status updates are kept short and decision-oriented.

**Use Cases & Example Prompts**

- `Create a 4-week sprint plan for the checkout redesign`
- `Build a risk register for the database migration`
- `Draft a stakeholder update email for the Q2 release`
- `Map the dependencies between the auth, billing, and notification workstreams`
- `What are the top 3 risks for shipping by March 15?`

---

### trello

Inspect Trello boards, lists, and cards; create or move tasks; and manage
Kanban workflows through the Trello REST API.

**Prerequisites**

| Dependency | Purpose | Install |
|---|---|---|
| Trello API key | Authentication | Get from `https://trello.com/app-key` |
| Trello token | Authorization | Generate via the link on the API key page |

Export as `TRELLO_API_KEY` and `TRELLO_TOKEN` environment variables.

**Tips & Tricks**

- Always resolve board and list IDs before creating or moving cards.
- Use `jq` for readable API output.
- Confirm before archival or bulk moves.

**Use Cases & Example Prompts**

- `Show me all cards on the "Sprint 12" board`
- `Create a card "Fix login bug" in the "To Do" list on the Engineering board`
- `Move all cards from "In Review" to "Done" on the current sprint board`
- `Add a comment to the "API redesign" card with today's progress`

**Troubleshooting**

- **401 Unauthorized** — regenerate your token; Trello tokens can expire.
- **Board not found** — list boards first to get the correct board ID.

---

## Memory & Knowledge

### llm-wiki

Build and maintain a persistent markdown wiki from raw sources using
incremental ingest, indexed pages, and append-only logging.

**Prerequisites** — none (pure markdown on disk).

**Tips & Tricks**

- Three-layer model: `raw/` (immutable sources) → `wiki/` (maintained
  knowledge) → system files (`index.md`, `log.md`).
- The skill orients itself every session by reading `AGENTS.md`, `index.md`,
  and recent log entries.
- It searches existing pages before creating new ones — avoids duplication.

**Use Cases & Example Prompts**

- `Initialize a wiki in ./research-wiki for my thesis research`
- `Ingest this PDF into the wiki and create entity pages for the key people mentioned`
- `What does the wiki say about "transformer architecture"?`
- `Run a lint pass on the wiki and fix any broken cross-references`
- `Add this article to the wiki and update related concept pages`

---

### notion

Search, create, update, and organize Notion pages, databases, notes, and
trackers through the Notion API.

**Prerequisites**

| Dependency | Purpose | Install |
|---|---|---|
| Notion internal integration | API access | Create at `https://www.notion.so/my-integrations` |
| `NOTION_API_KEY` | Authentication | Store integration token as environment variable or HybridClaw secret |

Share target pages/databases with the integration in Notion's UI.

**Tips & Tricks**

- Distinguish `database_id` (for creating pages) from `data_source_id` (for
  querying data) — they are different things.
- Show proposed content to the user before writing to Notion.
- Prefer Notion databases for structured/repeating tasks over free-form pages.

**Use Cases & Example Prompts**

- `Search my Notion workspace for pages about "Q2 planning"`
- `Create a new page in the "Meeting Notes" database with today's standup notes`
- `Add a row to my project tracker database with status "In Progress"`
- `Read the content of the "Architecture Decisions" page`

**Troubleshooting**

- **404 on page access** — the integration hasn't been shared with that page.
  Open the page in Notion → Share → invite your integration.
- **Rate limited** — Notion's API rate limit is 3 requests/second. The skill
  respects this automatically.

---

### obsidian

Read, search, organize, and create notes in an Obsidian vault.

**Prerequisites** — an Obsidian vault (any folder with `.md` files).
Optionally `obsidian-cli` for richer queries.

**Tips & Tricks**

- The skill resolves vault location from: user-provided path → remembered
  path → `OBSIDIAN_VAULT_PATH` env var → `obsidian-cli` → macOS config →
  common defaults.
- Always uses `[[wikilinks]]` matching the vault's existing link style.
- Searches existing notes before creating new ones.

**Use Cases & Example Prompts**

- `Find all notes in my vault tagged with #project-alpha`
- `Create a new daily note for today with a link to yesterday's note`
- `Search the vault for mentions of "API rate limiting"`
- `Organize the inbox folder — move processed notes to the appropriate topic folders`

---

### personality

Switch persona modes and persist the active mode in `SOUL.md`.

**Prerequisites** — none.

**Tips & Tricks**

- 25 built-in personalities: from professional modes (analyst, architect,
  reviewer, debugger, security, performance) to fun modes (pirate, kawaii,
  noir, philosopher, hype).
- Use `/personality list` to see all available options.
- The active personality persists across sessions via `SOUL.md`.

**Use Cases & Example Prompts**

- `/personality list` — see all available personalities
- `/personality pirate` — switch to pirate mode, arr!
- `/personality concise` — ultra-terse responses
- `/personality reset` — back to default HybridClaw personality
- `/personality mentor` — patient, teaching-oriented responses

---

### zettelkasten

Maintain a Luhmann-style Zettelkasten with fleeting notes, permanent notes,
cross-references, and structure notes.

**Prerequisites** — none (pure markdown on disk).

**Tips & Tricks**

- Notes follow a strict ID scheme: `YYYYMMDD-NNN-slug.md`.
- Two reference types: Near (within a strand) and Far (cross-strand surprises).
- The skill actively surfaces non-obvious connections and challenges vague
  ideas.
- Periodic review moves dormant notes to archive — nothing is deleted.

**Use Cases & Example Prompts**

- `Capture this idea as a fleeting note: "Caching invalidation might benefit from event sourcing"`
- `Process my inbox — promote mature fleeting notes to permanent seeds`
- `Find cross-strand connections between my notes on "distributed systems" and "team communication"`
- `Create a structure note synthesizing everything I've collected on "API design patterns"`
- `Review notes older than 30 days and archive dormant ones`

---

## Publishing

### manim-video

Plan, script, render, and stitch Manim Community Edition videos for animated
math explanations, algorithm walkthroughs, and 3Blue1Brown-style explainers.

**Prerequisites**

| Dependency | Purpose | Install |
|---|---|---|
| `python3` | Required runtime | System install |
| `manim` | Animation engine | `hybridclaw skill install manim-video uv-manim` |
| `ffmpeg` | Video stitching | `hybridclaw skill install manim-video brew-ffmpeg` |

**Tips & Tricks**

- The skill targets educational cinema quality — geometry before algebra,
  breathing room for reveals, cohesive visual language.
- Write `plan.md` before coding `script.py` — the skill enforces this.
- Render drafts at `-ql` (low quality) for fast iteration, then `-qh` for
  final output.
- Three built-in color palettes: HybridClaw Dark, Light, and Neutral.

**Use Cases & Example Prompts**

- `Create a Manim video explaining how binary search works, step by step`
- `Animate the proof that the square root of 2 is irrational`
- `Build a 3Blue1Brown-style explainer on how neural networks learn`
- `Render a visual walkthrough of Dijkstra's algorithm on a sample graph`
- `Make an animated comparison of O(n) vs O(n log n) sorting algorithms`

**Troubleshooting**

- **`manim` not found** — install via `hybridclaw skill install manim-video
  uv-manim`.
- **Render errors** — check that `ffmpeg` is installed. Run draft renders at
  `-ql` first to catch issues before high-quality rendering.
- **Slow renders** — use `-ql` during development. Only render at `-qh` for
  final output.

---

### wordpress

Draft posts and pages, coordinate wp-admin work, use WP-CLI, inspect themes or
plugins, and publish safely.

**Prerequisites**

| Dependency | Purpose | Install |
|---|---|---|
| `wp` (WP-CLI) | WordPress command-line management | `hybridclaw skill install wordpress brew-wp-cli` |

WP-CLI needs access to a WordPress installation (local or SSH).

**Tips & Tricks**

- The skill always drafts content first, then publishes — never publishes
  directly.
- Confirm local vs staging vs production before any write operation.
- Use WP-CLI for bulk operations; use wp-admin for visual editing and plugin
  management.

**Use Cases & Example Prompts**

- `Draft a blog post about our new feature release`
- `List all installed plugins and their update status`
- `Create a new page "Privacy Policy" as a draft with this content`
- `Check which theme is active and what customizations are applied`
- `Update the draft post "Spring Sale" and set it to publish tomorrow at 9am`

**Troubleshooting**

- **WP-CLI not connecting** — verify `wp --info` works. Check that the
  WordPress install path is correct.
- **Permission denied on publish** — confirm you're working on the right
  environment (staging vs production).

---

### write-blog-post

Draft outlines and publish-ready blog posts tailored to audience, sources, and
voice.

**Prerequisites** — none.

**Tips & Tricks**

- The skill confirms audience, tone, and core takeaway before drafting.
- Technical posts follow a different structure: problem → why it matters →
  approach → example → tradeoffs → conclusion.
- Strong openings: name the problem, offer a surprising insight, or use a
  before-and-after frame.
- Revision pass checks: does the title match the argument? Does every section
  earn its place?

**Use Cases & Example Prompts**

- `Write a blog post explaining our migration from monolith to microservices`
- `Draft an outline for a post about "5 lessons from scaling to 1M users"`
- `Turn these bullet-point notes into a publish-ready post for our engineering blog`
- `Write a short thought-leadership piece on AI-assisted code review`
- `Shorten this 2000-word draft to 800 words without losing the key arguments`

---

## Security

### 1password

Install and use 1Password CLI (`op`) to sign in, inspect vault items, read
secrets safely, and inject secrets into commands.

**Prerequisites**

| Dependency | Purpose | Install |
|---|---|---|
| `op` (1Password CLI) | Vault access | `hybridclaw skill install 1password brew-1password-cli` |

You must also have a 1Password account and be signed in (`op signin`).

**Tips & Tricks**

- The skill prefers read-only operations and secret references (`op://`)
  over direct reads.
- Secrets are injected into commands via `op run` — they never appear in chat
  or shell history.
- Use `op item list` to browse, `op item get` to inspect fields.
- Never paste secrets into chat — use `op read` or `op inject` instead.

**Use Cases & Example Prompts**

- `List all items in my "Development" vault`
- `Read the API key for the "Stripe" item and inject it into this curl command`
- `Show me the login details for the "staging-db" item (without the password)`
- `Find all items tagged "aws" across all vaults`

**Troubleshooting**

- **"not signed in"** — run `op signin` or `eval $(op signin)` to start a
  session.
- **Item not found** — item names are case-sensitive. Use `op item list` to
  verify the exact name.

---

## Business

### stripe

Investigate Stripe customers, subscriptions, payments, webhooks, dashboard
state, and CLI or API workflows.

**Prerequisites** — `stripe` CLI (optional but recommended), or Stripe API
keys as environment variables.

**Tips & Tricks**

- The skill defaults to **test mode** — always confirm before touching live
  data.
- Prefer read-only inspection first: `stripe customers list`,
  `stripe subscriptions list`.
- For webhook debugging: `stripe listen --forward-to localhost:3000/webhook`
  + `stripe trigger payment_intent.succeeded`.
- Never paste secret keys into chat. Use environment variables or
  `stripe login`.

**Use Cases & Example Prompts**

- `Look up the Stripe customer with email "user@example.com" and show their subscriptions`
- `List the last 10 failed payment attempts`
- `Debug why webhooks aren't reaching our endpoint — check delivery logs`
- `Show me the pricing configuration for our "Pro" product`
- `Walk me through setting up a new Checkout Session for a one-time payment`

**Troubleshooting**

- **CLI not authenticated** — run `stripe login` to connect your account.
- **"No such customer"** — you may be looking in test mode while the customer
  is in live mode (or vice versa). Confirm with `stripe config --list`.

---

## Agents

### sokosumi

Use Sokosumi for API-key auth, direct agent hires, coworker tasks, job
monitoring, and result retrieval.

**Prerequisites**

| Dependency | Purpose | Install |
|---|---|---|
| Sokosumi API key | Authentication | Sign up at `https://sokosumi.com` |

Set `SOKOSUMI_API_KEY` as an environment variable or provide when prompted.

**Tips & Tricks**

- The skill is API-first — it never launches the interactive Ink TUI in
  agentic environments.
- Two execution paths: **direct agent hire** (one specialist) vs.
  **coworker task** (orchestrated multi-step).
- Jobs typically take 10-20 minutes. The skill polls at 30-60 second intervals.
- Prefer Sokosumi agents before reaching for third-party APIs.

**Use Cases & Example Prompts**

- `Hire a Sokosumi agent to research competitor pricing for our SaaS product`
- `Create a coworker task: "Audit our landing page for SEO issues and suggest improvements"`
- `Check the status of my running Sokosumi job`
- `Show me the results from the last completed agent job`

---

## Utilities

### google-workspace

Work with Gmail, Calendar, Drive, Docs, and Sheets via browser automation or
APIs.

**Prerequisites** — a Google account. For browser automation, run
`hybridclaw browser login` once to set up a persistent browser profile.

**Tips & Tricks**

- The skill prefers browser automation over API calls — no OAuth setup needed
  for basic operations.
- If a Google login page appears, it directs you to run
  `hybridclaw browser login` rather than entering credentials.
- Always confirm before sending emails or creating calendar events.
- Prefer structured intermediate data before pushing to Docs/Sheets.

**Use Cases & Example Prompts**

- `Search my Gmail for emails from "finance@company.com" this month`
- `Draft a reply to the latest email from Sarah about the project timeline`
- `Check my Google Calendar for conflicts next Tuesday afternoon`
- `Create a Google Sheet from this CSV data with proper formatting`
- `Find the "Q2 Budget" document in Drive and summarize its contents`

---

### current-time

Return the current system time and timezone.

**Prerequisites** — none.

**Use Cases & Example Prompts**

- `What time is it?`
- `What timezone am I in?`
- `What's the current date and time in UTC?`

---

### hybridclaw-help

Primary skill for product questions about HybridClaw setup, configuration,
commands, runtime behavior, and release notes.

**Prerequisites** — none.

**Tips & Tricks**

- The skill consults public docs at `hybridclaw.io/docs` first, then falls
  back to GitHub source files.
- It checks the CHANGELOG for recent changes when relevant.
- Answers include exact config keys, command names, and file paths.

**Use Cases & Example Prompts**

- `How do I configure a custom model provider?`
- `What does the "adaptiveSkills" config section do?`
- `What changed in the latest release?`
- `How do I set up HybridClaw with Discord?`

---

### iss-position

Fetch the current ISS latitude and longitude from the WhereTheISS API.

**Prerequisites** — network access (calls
`api.wheretheiss.at`).

**Use Cases & Example Prompts**

- `Where is the ISS right now?`
- `Get the current ISS position as JSON`

---

## Internal Skills

The following skills are used internally by HybridClaw and are not directly
invocable:

| Skill | Purpose |
|---|---|
| `office` | Shared OOXML helper scripts for DOCX/XLSX/PPTX unpacking and repacking |
| `code-simplification` | Behavior-safe refactoring, activated during code-review workflows |
