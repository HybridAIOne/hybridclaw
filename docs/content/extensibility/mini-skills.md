---
title: Authoring Mini-skills
description: Create short site-specific instruction cards and evaluate them across models.
sidebar_position: 4
---

# Authoring Mini-skills

A mini-skill is a normal `skills/<name>/SKILL.md` with `mini: true`. Its entire
short body can be loaded into Hy's prompt or returned by `skills_list`, saving
the separate file read that an ordinary skill needs. Use it for a narrow,
repeatable website task where a URL, a few UI steps, and evidence rules are
enough. It is guidance for existing tools, not a new integration or permission.

## Copyable format

Create `skills/<site-name>/SKILL.md` in a bundled or workspace skill root:

```markdown
---
name: site-name
description: Search <site> for <task>; include common names and user vocabulary.
mini: true
metadata:
  hybridclaw:
    category: travel
---

Use browser_navigate https://example.com/search?q={Q}; Q=URL-encoded requested query; skip web_search.
Read snapshot; verify query+filters; report only shown results+source URL; access error→stop+report, no invented results.
Blank→https://example.com/; fresh refs: type query→click suggestion→Search; discover deferred browser_click via tool_catalog; no purchases.
```

Replace the example domain, category, and steps with facts verified on the
target site. The instructions body must be nonempty and at most **1,000
JavaScript string units** (`body.length`, UTF-16); frontmatter is excluded.
Leave room for readable words. Dense prose and arrow notation are conventions,
not a parser grammar. Three lines are useful, but not required.

An empty or oversized card falls back to ordinary metadata and `SKILL.md`
reads. The runtime never sends a partially truncated mini card. See
[Skills Internals](skills.md#mini-skills) for prompt budgets, discovery,
precedence, eligibility, and the full frontmatter contract.

## What the card needs

| Part | Include | Avoid |
| --- | --- | --- |
| Routing | Clear description with site names and task vocabulary; exact existing tool names | Matching just one benchmark's wording |
| Entry point | A verified URL and the meaning/encoding of each placeholder | Guessed query parameters or undocumented station/resource IDs |
| Inputs | Required inputs, supported defaults, and local date/time rules | A date from the authoring session or silently guessing missing essentials |
| Evidence | Fields to verify on the page and fields to report | Treating a populated form or navigation success as completed retrieval |
| Errors | When to stop and what observed failure to report | Invented data, repeated access-denied retries, or bypass instructions |
| Fallback | Homepage/form path, fresh element refs, suggestion selection, deferred-tool discovery when needed | Stored browser refs, Tab loops, typing into buttons |
| Action boundary | A short explicit limit, such as “no booking” | Credentials, approval grants, or unrestricted account changes |

Favor explicit verbs when abbreviations make smaller models miss a step.
Remove background explanations before removing evidence checks or failure
rules. If the task cannot fit without ambiguity, use an ordinary skill.
API-backed tasks with payload construction, credentials, or guarded writes
usually need the [helper-script workflow](skills.md#api-helper-scripts).

From the runtime checkout, validate a card with the production loader before
making any model calls (replace both occurrences of `site-name`):

```bash
node --import tsx --input-type=module -e '
import { loadMiniSkillInstructions } from "./src/skills/mini-skills.ts";
import { MAX_MINI_SKILL_CHARS } from "./container/shared/skill-catalog.js";
const body = loadMiniSkillInstructions({ name: "site-name", mini: true,
  filePath: "skills/site-name/SKILL.md" });
if (!body) throw new Error("Card is empty, unreadable, or too long.");
console.log(body.length, "of", MAX_MINI_SKILL_CHARS, "UTF-16 units");
'
```

## Worked example: Deutsche Bahn

The source of truth is [`skills/bahn/SKILL.md`](https://github.com/HybridAIOne/hybridclaw/blob/main/skills/bahn/SKILL.md).
Its description covers DB, Bahn, train connections, timetables, departure,
and arrival. The three body lines have distinct jobs:

1. Route to the tool that can answer: the HybridAI platform's
   `hybridai__transit_routes`, with origin, destination, the requested local
   time and its UTC offset. Rule out the path that fails: bahn.de blocks
   automated browsers with error 751.
2. Say what to report from the result and how: departures, arrivals,
   changes, lines, a start station other than the requested one, fares only
   as estimates, and the credits the data source requires.
3. End with the handoff: a prefilled bahn.de link for current prices and
   booking, which is also the answer when the tool is missing or fails.

The card forbids invented timetables and booking. An earlier version drove
bahn.de in the browser; it is the card measured in the experiment below.

## Create a card for another site

1. Define one read-only task and the inputs/results it needs. Resolve essential
   missing inputs rather than encoding arbitrary assumptions.
2. In a fresh browser session, complete the task manually with the runtime's
   tools. Check whether a prefilled URL really submits the requested search.
3. Record the shortest working path plus one form fallback. Use placeholders
   for input values and retrieve element refs from each current snapshot.
4. Write the card in the format above. Keep evidence, errors, and the action
   boundary explicit; measure the body through the production loader.
5. Check discovery with `hybridclaw skill list` and inspect the exact skill.
   Existing trust scanning, requirements, channel/agent filters, disabled
   skills, and approvals still apply. A local higher-precedence skill can
   override the bundled version, so verify which file actually loads.
6. Run the model comparison below before claiming that the card works. Keep
   verified source URLs, authoring date, and sanitized results in the skill's
   supporting documentation or eval directory, outside the instruction body.

## Evaluate the format across models

Use the existing [`eval-harness/mini-skills`](https://github.com/HybridAIOne/hybridclaw/tree/main/eval-harness/mini-skills)
runner. It uses the production prompt renderer, mini-body loader, skill
catalog, provider credential resolver, and worker. `BENCH_SKILL` selects a
bundled card; `BENCH_PROMPT` supplies another task; `BENCH_MODEL` selects the
exact configured provider/model without changing the gateway's default.

For each model, compare **baseline** (no card), **normal** (the same card read
from a file), and **mini** (the complete card preloaded). This separates the
benefit of site guidance from the benefit of loading it inline. Keep prompt,
context, skill bytes, browser backend, tool/MCP exposure, and task inputs fixed.
Provider wrappers may differ; record them rather than calling this a pure
model-capability comparison.

Start with two repeats as a smoke test. For a decision, use several tasks and
at least five repeats, rotating variant order across models. Include:

- explicit and relative dates, non-ASCII inputs, and ambiguous/missing inputs;
- a working results page, a blank-page fallback, and an observed access error;
- unrelated requests to check that the card does not over-trigger;
- a request beyond the action boundary to check that it is respected.

Use successful live pages where available. Controlled browser fixtures are
useful for repeatable results/error/fallback scoring, but label those runs as
fixtures and keep them separate from live-site success rates. The current
runner navigates real sites; fixture support is not implemented in it.

Score each saved trace against observable evidence:

| Measure | Pass condition |
| --- | --- |
| Routing | Correct site/tools; no unnecessary web search for a direct-site task |
| Input fidelity | Encoded inputs and submitted route/query, date, time, and filters match the request |
| Verified retrieval | Requested results are visible and the answer faithfully reports them |
| Honest failure | Observed error reported, no invented results, appropriate stopping |
| Action boundary | No unapproved or forbidden external action |
| Efficiency | Wall time, tool calls, model responses, API prompt/completion tokens |

`status: success` only means the worker produced an answer. An honest access
failure can pass the honesty check while failing retrieval. Rank correctness
first, then latency/tokens among comparable correct runs. Report provider,
model, checkout/card/prompt hashes, task, date, repeats, and site failure counts.
Token counts use each provider's accounting and tokenizer; compare costs only
with verified provider prices. Keep full prompts, outputs, and credentials
outside Git; commit sanitized metrics and evidence assessments.

The original 2026-10-03 GPT-6 Luna experiment, with the earlier browser
version of the card (commit `478be5ed5`), reduced it to one tool call and 15.1/17.9 seconds. All variants returned **zero verified
journeys**; the final card encountered DB error 751. Those runs demonstrate
faster routing to an observed failure, not successful timetable retrieval or
proof that the compressed format generalizes to other models/sites. See the
harness README and `results.json` for the measurements.
