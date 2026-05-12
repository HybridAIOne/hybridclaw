---
title: "Morning Competitor Briefing"
description: Build a weekday competitor briefing for a small business owner and deliver it to Telegram or the local inbox.
sidebar_position: 2
---

# Morning Competitor Briefing

Most competitor digests fail the same way: a 40-item link dump, arriving
after the day has already started, with no opinion attached. Executives stop
reading after the first paragraph. You stop opening them after a week.

This tutorial builds the opposite of that. A tight, four-minute morning
briefing, delivered before 8 AM, that reads like a well-briefed analyst
walking into your kitchen: here is what changed overnight, here is what it
means for **you specifically**, here is the one thing to do about it today.

## What We're Building

1. Every weekday morning, the job runs automatically before you sit down.
2. HybridClaw monitors a short watchlist of competitors across five signal
   types: pricing, product launches, partnerships, hiring, and press.
3. It filters aggressively — the goal is five items, not fifty — and ranks
   them by impact on your business, not by recency.
4. It delivers a briefing you can read in four minutes, ending with **one**
   prioritized action for today and one open question for the week.

This pattern works especially well for agencies, local service companies,
SaaS shops, and niche B2B firms where a handful of competitors drive most
of the market dynamics you care about.

## Why These Signals

The briefing is built around five signal categories because each one leaks
strategy at a different lead time:

- **Pricing page changes** are the fastest competitive tell. A new tier,
  a dropped price, or a reworded headline usually precedes a positioning
  shift by days, not months.
- **Product launches and changelog entries** reveal what they are betting
  on *now*.
- **Partnership and integration announcements** signal where they want
  distribution to come from next quarter.
- **Job postings** leak the roadmap six to twelve months early — a sudden
  burst of "AI engineer" or "Solutions Architect, EMEA" hires tells you
  more than any press release.
- **Press, podcast, and social presence** tells you how they are trying
  to be perceived, which is often a tell on where the product isn't
  keeping up.

The point is not to cover all five every day. It is to notice when
multiple signals line up — that's when a competitor is actually moving.

## Prerequisites

Before starting, make sure you have:

- HybridClaw installed and running
- web search configured; see [Web Search](../../reference/tools/web-search.md)
- a delivery surface; Telegram is ideal because push beats pull at 7:30
  AM, but the local TUI or web chat also work

For Telegram delivery, configure the channel once from the
[Admin Console](../../channels/admin-console.md) at `/admin/channels`.
Paste the bot token from BotFather, add your own Telegram user ID to the
allowlist, and save. The Admin Console writes the same runtime config in
both local installs and the HybridClaw cloud offering. See
[Telegram](../../channels/telegram.md) for the full field reference.

## Step 1: Nail The Briefing Spec By Hand

Before you automate anything, write a prompt that produces a briefing you
actually *want* to read. Open a local session:

```bash
hybridclaw tui
```

Then send a prompt built around three ideas that separate a good briefing
from a noisy one:

1. **Headlines are conclusions, not topics.** Not "Acme CRM pricing
   update" — write "Acme CRM just undercut our Starter tier by 20%".
2. **Every item follows FIA: Fact, Impact, Action.** What changed, what
   it means for *this business*, what to do about it and by when.
3. **Top-of-briefing answers the only question the reader has at 7:30
   AM:** what is the one thing I should do today because of this?

> 🎯 **Try it yourself**
>
> ```text
> You are my competitive analyst. Produce a weekday morning briefing for
> the owner of a small B2B SaaS company, readable in four minutes.
>
> Watchlist:
> - Acme CRM
> - Northstar Digital
> - BluePeak Analytics
>
> Signals to monitor (in order of priority):
> 1. pricing page changes and new plans
> 2. product launches, feature releases, changelog entries
> 3. partnerships, integrations, reseller announcements
> 4. hiring spikes or new senior roles (LinkedIn, careers pages)
> 5. notable press, podcasts, or founder social posts
>
> Hard filters — discard:
> - generic funding announcements without a product angle
> - award posts, "great place to work" PR
> - reposts of material older than 14 days
> - anything you cannot attach a credible source link to
>
> Output format:
>
> ## Lead
> One sentence. The single most important thing that changed overnight
> and what I should do about it today.
>
> ## The Five
> Exactly five items, ranked by impact on my business (not by recency).
> For each item:
> - **Headline** — written as a conclusion, not a topic
> - **Fact** — 1-2 sentences on what actually happened
> - **Impact** — 1-2 sentences on why it matters *specifically* for a
>   small B2B SaaS owner
> - **Action** — one concrete thing I could do this week, or "monitor"
>   with a reason
> - **Source** — link, publisher, and date
>
> ## Watch List For The Week
> One open question to keep an eye on over the next five trading days.
>
> ## Confidence
> One line: how strong the signal mix is today (high / medium / low) and
> why.
>
> Keep the whole briefing under 500 words. If you do not have five items
> that clear the filters, return fewer — quality over quota.
> ```

Iterate on this prompt for three or four mornings before you schedule it.
Cut anything you skim past. If the Lead is weaker than The Five, the
prompt is still wrong.

## Step 2: Create The Recurring Job

Once the manual run produces something you would genuinely read with
coffee, schedule it.

### Option A: Ask Naturally

From the Telegram DM where you want the briefing delivered:

> 🎯 **Try it yourself**
>
> ```text
> Every weekday at 7:30am, run the competitor briefing from our earlier
> conversation for Acme CRM, Northstar Digital, and BluePeak Analytics.
> Use the same signals, filters, and output format: Lead, The Five (with
> Fact / Impact / Action / Source), Watch List For The Week, Confidence.
> Under 500 words. Quality over quota — return fewer than five items if
> the filters do not clear.
> ```

Scheduling from the same chat where you want the result means the
finished briefing lands there automatically.

### Option B: Use An Explicit Schedule Command

From local TUI or web chat:

> 🎯 **Try it yourself**
>
> ```text
> /schedule add "30 7 * * 1-5" You are my competitive analyst. Produce a weekday morning briefing for the owner of a small B2B SaaS company, readable in four minutes. Watchlist: Acme CRM, Northstar Digital, BluePeak Analytics. Signals (ranked): pricing page changes, product launches, partnerships, hiring spikes, notable press. Discard funding fluff, awards, reposts older than 14 days, and anything without a credible source. Output: Lead (1 sentence with today's action), The Five (ranked by impact, each with Headline as conclusion, Fact, Impact for a small B2B SaaS owner, Action, and Source), Watch List For The Week (1 open question), Confidence (high/medium/low with reason). Under 500 words. Quality over quota.
> ```

List or remove jobs later with:

> 🎯 **Try it yourself**
>
> ```text
> /schedule list
> /schedule remove <id>
> ```

## The Rule That Matters

Scheduled jobs start fresh every morning. They do not remember yesterday's
briefing, your watchlist, or the format you liked. So never write:

> 🎯 **Try it yourself**
>
> ```text
> Do the usual competitor briefing.
> ```

Write the full spec every time. Which competitors, which signals in which
order, which filters, the reader's role, the exact output format, and the
word budget. A briefing that drifts one day drifts permanently.

## Quality Rubric

After a week, grade each briefing on four questions. If any answer is
"no", tighten the prompt:

1. Could I explain the Lead to a co-founder in one sentence without
   re-reading it?
2. Does every Impact line mention *my* business, not the market in
   general?
3. Is every Action either something I could do this week or an explicit
   "monitor" with a reason?
4. Could I defend every Source to a skeptical investor (named publisher,
   dated, primary where possible)?

Three yeses out of four is acceptable. Two or fewer means the briefing
has quietly become a link dump and needs a reset.

## Useful Variations

- Swap the reader to "owner of a local home-services business" to get
  more tactical pricing, offers, and local positioning language.
- Add a country or region when your market is geographically bounded —
  it sharpens the hiring and partnership filters dramatically.
- Split **The Five** into "Direct competitors" and "Adjacent market
  shifts" when the adjacent category starts crowding out direct moves.
- Add a sixth block called `Risks this week` on Mondays only, for a
  forward-looking rather than backward-looking lens.
- Run a Friday-only variant with a single section: `What the week told
  me that I did not already know on Monday`.

## Production Tips

- Keep the watchlist short. Three to six names is the sweet spot; more
  than eight and the Lead always gets diluted.
- Tell HybridClaw what to ignore as loudly as what to include — the
  filters are what make the briefing worth opening.
- Review and rewrite the prompt monthly. Competitors change, your
  priorities change, and the prompt should too.
- If a scheduled job silently stops firing, check the gateway status
  page in the Admin Console or ask in your HybridClaw chat session
  — the scheduler surfaces the last run and any error reason there.
- Archive briefings in a Notes folder or a pinned Telegram chat. The
  trend across two weeks is often more useful than any single morning.

## Going Further

- [Telegram](../../channels/telegram.md)
- [Commands](../../reference/commands.md)
- [Web Search](../../reference/tools/web-search.md)
