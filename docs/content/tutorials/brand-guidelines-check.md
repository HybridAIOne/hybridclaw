---
title: "Check If A Document Adheres To Our Brand Guidelines"
description: Build a reviewer that checks any document, slide deck, or post against your brand guidelines and returns a prioritized list of fixes.
sidebar_position: 19
---

# Check If A Document Adheres To Our Brand Guidelines

Most brand breaches don't come from bad intent. They come from a founder
shipping a deck at midnight, a new hire guessing at the tone, or a
contractor who never read the brand book. By the time someone notices,
the file is already with the customer.

This tutorial builds a brand reviewer with HybridClaw. You hand it a
document — a proposal, a deck, a landing page copy, a LinkedIn post —
and it returns a prioritized list of fixes against **your** brand
guidelines, not a generic checklist. Used before sending, it catches
drift in minutes.

## What We're Building

1. You save your brand guidelines once as a single markdown file the
   reviewer can read every time.
2. You hand HybridClaw any document (`.docx`, `.pptx`, `.pdf`, `.md`,
   `.txt`, or a pasted URL or body).
3. HybridClaw scores it against the guidelines across five dimensions:
   voice, terminology, visual/typographic rules (where observable),
   messaging architecture, and compliance boilerplate.
4. It returns a prioritized list of fixes — must-fix, should-fix,
   nice-to-have — with the exact location in the document and a
   proposed rewrite where a rewrite is cheap.

This is a strong fit for agencies reviewing contractor output, SaaS
companies keeping a consistent voice across sales and marketing, and
founder-led teams where every new hire is one slide away from accidentally
rebranding the company.

## Prerequisites

Before starting, make sure you have:

- HybridClaw installed and the gateway running
- the bundled document tools available to read `.docx`, `.pptx`, and
  `.pdf` inputs; see [Office Dependencies](../office-dependencies.md)
- a brand guidelines document, even a rough one — one page is fine to
  start, you will improve it as the reviewer surfaces gaps

## Step 1: Capture Your Brand Guidelines As One File

The reviewer is only as strict as the guidelines you give it. Do not
paste a 60-page brand book on day one. Start with the rules you would
actually enforce on a Monday morning.

Save the following as `brand-guidelines.md` in a known folder. Fill in
each section with the shortest possible rules — bullets beat paragraphs.

```markdown
# Brand Guidelines — <Company>

## Voice
- we sound like: <three adjectives, e.g. calm, precise, plainspoken>
- we do NOT sound like: <three, e.g. hypey, jargon-heavy, corporate>
- point of view: first person plural ("we") in marketing, first person
  singular ("I") in founder posts, never "the team" or "the company"

## Terminology
- always: <preferred terms, e.g. "customer" not "user", "platform" not
  "software", "data" as singular>
- never: <banned terms, e.g. "solution", "leverage", "utilize",
  "cutting-edge", "revolutionary", "synergy">
- product names: <exact casing, e.g. HybridClaw (one word, capital H, C)>
- always explain before acronym: first use "retrieval-augmented generation
  (RAG)", thereafter RAG

## Messaging Architecture
- one-line pitch: <the canonical sentence>
- three proof points: <the three claims we always back>
- audience priority: <e.g. operators first, developers second,
  executives third>
- what we do NOT claim: <e.g. no "AI that thinks", no "fully autonomous",
  no 10x productivity claims without a source>

## Visual & Typographic Rules (for slides and documents)
- primary typeface: <e.g. Inter for body, Söhne for display>
- color palette: <list hex codes, e.g. brand blue #1756E5, ink #0B0F19>
- logo: minimum clear space equal to the cap height of the logotype
- never: stretched, rotated, gradient-overlaid, or stroked logos
- screenshots: always on a neutral background, never on a product screen
  with live customer data

## Compliance & Legal Boilerplate
- every public-facing document that quotes a customer needs attribution
  and date
- never state an uptime or performance number without a linked source
- GDPR: never collect email without an explicit opt-in sentence on the
  same visible frame

## Non-Goals
- we are not a brand that preaches ("revolutionizing X")
- we are not a brand that apologizes ("humbly believe")
- we do not use emojis in body copy; they are allowed in social and
  slack posts only
```

A one-page version is enough to start. The reviewer will tell you which
sections are vague; tighten them as you go.

## Step 2: Test The Reviewer Manually

Open a local session:

```bash
hybridclaw tui
```

Upload or paste the document under review along with the guidelines file.
Then run this prompt. The format is deliberately opinionated: must-fix
first, exact locations, proposed rewrites where they are cheap.

> 🎯 **Try it yourself**
>
> ```text
> You are my brand reviewer. Read the attached brand guidelines, then
> read the attached document, then return a structured brand review.
>
> Guidelines file: brand-guidelines.md
> Document under review: <filename or pasted content>
> Document type: <proposal | deck | landing-page copy | social post |
>                email | case study | press release>
> Audience for the document: <e.g. mid-market CFO, developer advocate,
>                              existing customer>
>
> Review the document against these five dimensions, in this order:
>
> 1. Voice — does it match the "sounds like" / "not like" rules?
> 2. Terminology — any banned terms, any missing preferred terms, any
>    product-name casing errors, any unexplained acronyms?
> 3. Messaging architecture — does it lead with our one-line pitch and
>    back the claim with our proof points? Does it avoid the "do not
>    claim" list?
> 4. Visual & typographic rules — only flag what is observable in the
>    file (typeface in a .docx/.pptx, logo usage, color codes if present).
>    Do not hallucinate; say "not observable" if you cannot see it.
> 5. Compliance — attributions, date stamps, performance claims with
>    sources, GDPR opt-in where relevant.
>
> Output format:
>
> ## Verdict
> One sentence: ship-ready, ship with fixes, or do-not-ship, and why.
>
> ## Must-fix (blocks shipping)
> Each item:
> - **Location** — exact quote or page/slide/paragraph reference
> - **Rule broken** — which guideline section and rule
> - **Why it matters** — one sentence
> - **Proposed rewrite** — if the fix is a phrase or sentence, propose
>   it verbatim. If structural, describe the change.
>
> ## Should-fix (before next revision)
> Same four-field format.
>
> ## Nice-to-have (style polish)
> Same four-field format.
>
> ## Not-observable
> List what you could not verify and what would be needed to check it
> (e.g. "brand color hex values not embedded in .docx file; export as
> PDF or provide a color-checked screenshot").
>
> ## Guidelines gaps
> One section listing any issue in the document that the guidelines
> do NOT cover clearly. These are prompts for us to improve the
> guidelines file.
>
> Rules for the review:
> - quote exact phrases, do not paraphrase
> - never invent a rule that is not in the guidelines file
> - if a rule contradicts itself, flag it in the "Guidelines gaps"
>   section rather than guessing
> - prefer fewer, sharper fixes over an exhaustive list
> ```

Iterate on the prompt and on the guidelines file together. Every
"Guidelines gaps" item is a tighten-the-guidelines task, not a reviewer
failure.

## Step 3: Wire It Into How Work Actually Flows

The reviewer is useless if it only runs when someone remembers. Pick
one of these patterns and stick with it.

### Pattern A: Review-On-Mention In Telegram Or Slack

From the team chat where docs are shared for review:

> 🎯 **Try it yourself**
>
> ```text
> When someone shares a document in this chat and asks for a brand
> review, run the brand reviewer against our saved brand-guidelines.md
> and post the review back in the same thread. If the document is a
> URL, fetch and review the page body. If the verdict is "do-not-ship",
> prepend the response with a single red flag in the first line.
> ```

### Pattern B: Scheduled Sweep Of A Shared Folder

If your team drops drafts into a shared folder:

> 🎯 **Try it yourself**
>
> ```text
> /schedule add "0 9 * * 1-5" Every weekday morning, review every document added to the "for-brand-review" folder since yesterday. Use our saved brand-guidelines.md. For each document, return the verdict, the must-fix list, and a one-sentence summary. Skip documents already reviewed.
> ```

### Pattern C: One-Shot Pre-Send Check

For the founder or a single reviewer, the simplest pattern is a manual
kickoff right before hitting send. No schedule, no chatbot, just a
habit:

> 🎯 **Try it yourself**
>
> ```text
> Review the document I just uploaded against our saved
> brand-guidelines.md. Use the standard five-dimension review with
> verdict, must-fix, should-fix, nice-to-have, not-observable, and
> guidelines-gaps sections. Be strict — I would rather fix one thing
> twice than miss it once.
> ```

## The Rules That Matter

Three rules keep the reviewer honest.

**The reviewer only knows what is in the guidelines file.** If the
reviewer misses an obvious issue, the fix is almost always to add a
line to `brand-guidelines.md`, not to make the prompt longer. A sharp
one-page guideline beats a vague ten-page one every time.

**Quote, don't paraphrase.** The review is only useful if you can jump
to the exact sentence and change it. Insist on verbatim quotes; reject
summaries.

**Separate must-fix from polish.** If everything is important, nothing
ships. The ordered sections exist so a tired reviewer can fix three
things in ten minutes and move on.

## Useful Variations

- **Tone-only pass** for a social post. Strip the checklist to voice
  and terminology. A LinkedIn post does not need a compliance section.
- **Localized review** when you publish in multiple languages. Add a
  "Translation quality" dimension and ask for flagged literal
  translations that read awkwardly to a native speaker.
- **Legal-lite pass** for investor material. Add a sixth dimension
  covering forward-looking statements and any performance claims that
  need a safe-harbor footer.
- **Diff-mode review.** Ask for a review of only what changed between
  version N-1 and N. Useful in late-stage doc editing where a full
  review is noise.
- **Brand-fit scoring for external content.** Point the reviewer at a
  press article, partner co-marketing draft, or analyst report to
  check whether external coverage matches how you actually talk about
  yourself.

## Production Tips

- Keep `brand-guidelines.md` under 500 lines. Long guidelines get
  ignored; short ones get enforced.
- Every time the reviewer flags a "Guidelines gap", spend two minutes
  updating the file. After a month the gaps dry up.
- Do not run the reviewer against its own output. Reviews are not
  copy-edited documents; they are worksheets.
- Review the reviewer monthly. Scan ten reviews and ask: did it miss
  anything real? Did it flag anything that was actually fine? Both are
  prompts to tighten either the guidelines or the prompt.
- When a "must-fix" slips through to a published document, treat it as
  a guideline bug, not a reviewer bug. Write the rule that would have
  caught it next time.

## Going Further

- [Office Dependencies](../office-dependencies.md)
- [Commands](../../reference/commands.md)
- [Adaptive Skills](../../extensibility/adaptive-skills.md)
