---
name: brand-voice
description: Author replies in the configured brand voice and pre-empt the brand-voice post_receive middleware so messages don't get rewritten or blocked downstream.
metadata:
  hybridclaw:
    category: communication
    short_description: "Stay on-brand before the guard intervenes."
    middleware:
      post_receive: true
---

# Brand Voice

This skill complements the `brand-voice` plugin. The plugin runs as
**post_receive middleware** after the assistant finishes a turn: it inspects
the final text against banned phrases, banned patterns, required phrases, and
an optional LLM classifier, then either allows, rewrites, or blocks the
response.

The plugin is a safety net. This skill is the up-front discipline that keeps
the safety net from firing.

## When to use

Activate this guidance whenever the response will reach an external
audience: customers, partners, stakeholders, public comments, marketing
copy, sales follow-ups, support replies. It is also a sensible default for
internal messages on user-facing channels (Slack to a customer team, email
to a vendor).

## Working rules

1. **Read the configured voice before drafting.** Run `/brand-voice` (the
   plugin command) to see the active mode, banned phrases, banned
   patterns, and required phrases. Treat that output as authoritative. If
   no voice is configured, write in clear neutral business prose and stop
   second-guessing tone.
2. **Lead with substance, not voice.** Brand voice is the polish on top of
   a correct, concrete answer. Never trade accuracy for tone.
3. **Avoid the banned set.** Do not use banned phrases or anything that
   matches the banned regex patterns. If a banned phrase is the most
   natural word, find a synonym or restructure the sentence — do not
   simply alias the banned word with a similar one.
4. **Honor required phrases when contextually appropriate.** If the config
   lists required phrases (e.g. a tagline, disclaimer, or salutation) and
   the response is a customer-facing message, include them. Do not insert
   them into purely internal or technical replies where they would feel
   forced.
5. **Mirror the caller's register.** If the user is informal, do not reply
   in stiff legalese; if they are formal, do not reply with slang. Brand
   voice describes the ceiling and floor, not the exact register.
6. **Preserve facts and citations across rewrites.** When you self-correct
   a draft for tone, keep every concrete claim, link, code block, and
   number unchanged.

## Failure modes the guard will catch

- Off-brand jokes, sarcasm, or hedges in customer-facing replies.
- Banned-phrase appearances ("guaranteed", "obviously", competitor names,
  …) — depends on configuration.
- Missing required disclaimers in regulated contexts.
- Sycophantic openings ("Great question!") or apology spirals when the
  voice is explicitly direct.

If you notice yourself drifting into any of these, stop and rewrite the
draft *before* sending. The guard's rewrite is a fallback; an in-thread
rewrite preserves intent better than a downstream model rewrite.

## Plugin interaction

- **Mode `flag`:** the guard only logs. Do not relax — drift will still
  show up in audit reports.
- **Mode `rewrite`:** the guard will call the configured aux model to
  rewrite off-brand output. This is the default, and it is not free —
  every off-brand response costs an extra model call and adds latency.
- **Mode `block`:** the guard replaces the message with a fixed
  `blockMessage`. Treat this as a hard error: an off-brand draft means the
  user gets nothing.

The cheapest, fastest, and highest-fidelity outcome is always: write
on-brand on the first pass.
