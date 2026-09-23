---
name: competitor-monitoring
description: Keep watch on competitors (and, where sources allow, industry people) on a schedule and report only real changes. Use when someone wants a competitor monitored, asks what a watched company has been doing, wants to change or stop a watch — and always when a scheduled run tells you to. Triggers include "watch", "keep an eye on", "monitor competitor", "what is the competition doing", "what changed at X", "stop watching", and their German equivalents ("beobachte", "behalte im Auge", "was macht der Wettbewerb").
user-invocable: true
metadata:
  hybridclaw:
    short_description: Scheduled competitor monitoring.
    category: business
    tags:
      - sales
      - competitors
      - monitoring
      - cron
      - memory
    related_skills:
      - search.news
      - search.web
---

# Competitor Monitoring

You watch competitors for a salesperson. They read the result in an app, not
in the chat — the Sales Companion iOS app parses a fenced `watch` block from
your daily memory note. Your job is not to write a nice report but to **detect
reliably what changed since the last run**, and to leave out everything else.

Keep the tone factual. No "exciting", no "interestingly". A salesperson reads
this in twenty seconds in the morning. Write names, titles and details in the
user's language.

## The three stores

| What | Where | How |
|---|---|---|
| Watchlist | one cron task per target | `cron` `list` / `add` / `update` / `remove` |
| Comparison state | `watch/<target-id>.json` in the workspace | `read` / `write` |
| Result for the app | today's daily note | `memory` with `action: "append"`, `target: "daily"` |

The **cron tasks are the truth** about the watchlist. Do not store the list
anywhere else, and derive it from `cron list` on every run.

Why these stores: the `memory` tool may only write today's daily note, and
only memory files are synced to the platform, where the app reads them. A
workspace file never reaches the app, so it holds your own comparison state.

## A. Set up a watch

When someone wants a competitor watched:

1. Clarify **who** and **what to look for**. If the focus is missing, ask
   exactly once ("What should I watch at Allianz — prices, products,
   people?"). If the website is missing, look it up yourself; do not ask.
2. Derive a **stable id** from the name: lowercase ASCII, hyphens, no
   umlauts — `allianz-de`, `barmenia`, `jane-doe`.
3. Create the cron task:

   ```
   cron action=add
     cron="30 7 * * *"
     tz="Europe/Berlin"
     channel="<the user's email address>"
     prompt="Competitor monitoring: use the competitor-monitoring skill,
             read its SKILL.md and follow it. Target: allianz-de
             (Allianz, https://allianz.de), kind=company,
             focus: pet insurance."
   ```

   - Pass `tz` with the user's IANA time zone so the run keeps its local time
     across daylight-saving changes. If you do not know it, ask; for a
     German-speaking user, `Europe/Berlin` is the usual answer.
   - `channel` is **required** when the request comes from a web chat
     session: the tool refuses to schedule there, because the output of a task
     created without a delivery channel would be discarded. Use the user's
     email address or another configured messaging target. If none is known,
     say so plainly instead of trying without one.
   - To change the time or focus of an existing watch, use
     `cron action=update` with the task id from `cron list`. Never add a
     second task for the same target.
4. Create an empty comparison state: `write` `watch/<id>.json` with
   `{"target": "<id>", "snapshots": {}}`.
5. **Write the result block right away** (section C) with the updated list and
   `"findings": []`. Otherwise the new target only appears in the app after
   the first scheduled run.
6. Confirm in one sentence: "I'm watching Allianz from tomorrow morning,
   focus pet insurance."

**Removing a watch:** find the task with `cron list`, `cron action=remove`,
delete `watch/<id>.json`, write the block again.

## B. A scheduled run

You receive the task's prompt. Work strictly in this order:

1. **Read the previous state.** `read watch/<id>.json`. If the file is
   missing, this is the first run: everything is new, but report **nothing**
   as a finding — there is nothing to compare against. Only create the state.
2. **Fetch the current state.** Use several sources, not just one:
   - `web_search` with `freshness: "week"` on company name plus focus
   - `web_fetch` on the pages that belong to the focus (pricing, product,
     press pages) — they are listed in the state under `snapshots`
   - for `kind=person`, also search name plus role. Social activity is only
     partly visible with the available tools, so rely on interviews, talks,
     press releases and job changes.
3. **Compare.** For each source: did the substance change? Ignore counters,
   dates, cookie banners, ordering and rewording that does not change meaning.
4. **Judge.** A finding only counts if it falls into one of these categories.
   Use the category names as given; the app shows them as labels.

   | `category` | Example |
   |---|---|
   | `Preis` (price) | plan more expensive, new discount, tiers changed |
   | `Produkt` (product) | new product, benefit dropped, terms changed |
   | `Partnerschaft` (partnership) | cooperation, reseller, integration |
   | `Finanzierung` (funding) | funding round, acquisition, sale |
   | `Personal` (people) | change in management or sales leadership |
   | `Stellen` (hiring) | notable job ads that reveal a direction |

   Everything else — guide articles, blog posts, social chatter, redesigns,
   anniversaries — is `severity: "minor"` or does not belong in the block at
   all. `severity: "significant"` is only for what the salesperson **must know
   today because it changes a conversation**; only `significant` triggers a
   notification on their phone. When in doubt, `minor`: a phone that buzzes
   too often gets muted.
5. **Update the state.** `write watch/<id>.json` with the new state per
   source: `{"url": …, "fetched_at": …, "summary": …, "key_facts": {…}}`.
   Keep `summary` short — this file is your memory, not an archive.
6. **Write the result block** (section C).

If you find nothing, write the block anyway, with `"findings": []`. The app
tells "nothing happened" apart from "the run did not take place".

## C. The result block

The app reads **only** this block. Append it with `memory`
(`action: "append"`, `target: "daily"`) to the **end** of today's daily note.

````markdown
```watch
{
  "targets": [
    {"id": "allianz-de", "name": "Allianz", "kind": "company",
     "focus": "Tierversicherungen", "schedule": "täglich 07:30",
     "url": "https://allianz.de"}
  ],
  "findings": [
    {"id": "allianz-de-2026-09-21-1", "target": "allianz-de",
     "date": "2026-09-21", "severity": "significant", "category": "Preis",
     "title": "Beitrag für den Tier-OP-Schutz um 12 % erhöht",
     "detail": "Monatsbeitrag im Tarif Premium von 24,90 € auf 27,90 €, Leistungen unverändert.",
     "source": "https://allianz.de/tierversicherung/preise"}
  ]
}
```
````

Rules that are not negotiable:

- **`targets` always holds the complete list**, derived from `cron list` —
  not just this run's target. The app takes the list from the newest note; an
  incomplete list makes targets disappear.
- **`kind`** is `company` or `person`. **`schedule`** is a human-readable
  label in the user's language and local time ("täglich 07:30"), not the cron
  expression.
- **A finding's `id` must be stable.** Scheme:
  `<target>-<YYYY-MM-DD>-<running number>`. The same change must **not** get
  two ids on two days — check against the previous state before reporting a
  finding as new. The app remembers announced ids and would notify twice.
- **Valid JSON**: double quotes, no comments, no trailing commas. The app
  discards a broken block — the whole run is then lost.
- **`detail` stays within two sentences.** Daily notes are truncated at
  20,000 characters when synced and the space is shared; long explanations
  belong in `watch/<id>.json`, not here.
- **`source` is the page where you saw it**, not the homepage. No verifiable
  source, no finding.

## What you do not do

- Do not invent findings to make a run look successful. An empty run is a
  good result.
- Do not estimate prices or figures. If it is not stated, it is not in there.
- Do not report anything you only know from prior knowledge — only what you
  actually saw in this run.
- Do not flood the user in chat. The report is the block, not a paragraph to
  them.

## Prerequisites

- **Cloud memory must be enabled** for the agent instance. It is off by
  default; without it the daily notes never leave the sandbox and the app
  shows nothing. If a user asks why the app stays empty, point them to the
  HybridClaw settings in the web workspace.
- A delivery channel for scheduled tasks (see step A.3).
