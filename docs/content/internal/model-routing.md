---
title: Model Routing — Configurable Tier Ladder with Escalation
description: One mechanism — an operator-configured ladder of model tiers; every turn starts as low as allowed and escalates on failure. Agents and skills set the starting rung and the limits. Nothing about tiers or hardware is hardcoded.
---

> **Internal document.** Design for the HybridClaw/HybridAI routing layer. Drafted 2026-07-17 on branch `claude/hybridclaw-routing-arch-6a6503`. Aligns with roadmap row R50 but is deliberately simpler than the roadmap sketch; where they differ, this document wins. Code anchors verified against this repo and `~/src/chat` on the same date.

# Model Routing — Configurable Tier Ladder with Escalation

## 1. The client sentence

> **DE:** „Jede Aufgabe startet auf dem günstigsten Modell, das sie beherrscht, und wechselt automatisch eine Stufe höher, wenn das nicht reicht — und Ihre Daten gehen nur dorthin, wo Sie es erlauben."
>
> **EN:** "Every task starts on the cheapest model that can do it, automatically steps up a tier when that isn't enough — and your data only goes where you allow."

That sentence is the whole mechanism. Everything else in this document is configuration, failure detection, and telemetry.

## 2. How it works

One config block. Tiers are an **ordered list** — the order *is* the ladder. Hardware and model names are operator config, never code:

```jsonc
"routing": {
  "enabled": true,
  "tiers": [
    // Example values — our fleet today. Any count, any names, any endpoints.
    // A tier may mix models from different privacy zones; the zone itself is
    // metadata on the model/endpoint entry (§ Privacy zones), not on the tier.
    { "name": "small",    "models": ["haigpu2/gemma-3n-e4b"] },              // zone: hai
    { "name": "standard", "models": ["haigpu1/qwen3.7-27b",                  // zone: hai
                                     "mistral/mistral-medium"] },            // zone: region
    { "name": "frontier", "models": ["hybridai/gpt-5-mini",                  // zone: cloud
                                     "hybridai/gpt-5"] }                     // zone: cloud
  ],
  "defaultStart": "standard",
  "escalationStickyTurns": 3,
  // Client controls (per tenant → agent → skill, most specific wins):
  "sovereignty": "region",                  // hard limit: local | hai | region | cloud
  "preferences": { "quality": 0.5, "speed": 0.3 }   // sliders; price is the default pull
}
```

Per turn:

1. **Start** at the lowest allowed rung: the skill's declared minimum, else the agent's start tier, else `defaultStart`. System chores (heartbeat, scheduler, compaction, titles, judges) start at the bottom.
2. **Escalate** to the next rung when the turn *demonstrably fails* (§4). Within a rung, multiple models are a fallback list (existing R28 engine).
3. **Stay up briefly**: after an escalation the session stays on the higher rung for `escalationStickyTurns`, then falls back to start. No other state.
4. **Three overrides**, checked in order: an **explicit pin** (user `/model` or per-request model) always wins; the **sovereignty limit** removes ineligible models from every rung before the ladder runs (§ Privacy zones); a **budget clamp** lowers the maximum rung as the agent's or plan's budget depletes.

The four things a client can buy are four knobs on this one mechanism, not four engines: **best price** = start low (default). **Budget** = the clamp. **Price/quality/speed** = the preference sliders. **Privacy** = the sovereignty limit. If a task exceeds the highest rung that survives the filters (e.g. sovereignty `hai` caps at the local 27B), the router never silently breaks the limit — it escalates to the operator (existing F14 pause/resume).

### Privacy zones — the second axis, orthogonal to tiers

Tiers answer *"how capable/expensive?"*; zones answer *"how far does the data travel?"*. Every model/endpoint entry in the catalog carries a **zone**, ordered by increasing exposure:

| Zone | Meaning | Examples (config, not code) |
|---|---|---|
| `local` | customer's own infrastructure — data never leaves the house | on-prem HybridClaw endpoints, R34 sovereign peers |
| `hai` | HybridAI's own EU fleet — our hardware, our DPA, no hyperscaler in the chain | haigpu1, haigpu2, future NVLink node |
| `region` | third-party processors with contractual EU-region residency | Azure EU, Mistral, IONOS, Aleph Alpha |
| `cloud` | global providers, no residency guarantee | OpenAI, Anthropic, Grok |

Mechanics, deliberately boring: zone is **metadata on the model/endpoint entry** (F5 catalog field; `zone:` on `local.endpoints[]`; a column on the backend's model catalog, exposed through `/v1/models`). A tier may mix zones. The client's `sovereignty` setting (per tenant → agent → skill) is a **maximum zone**: before the ladder runs, every rung is filtered to models within the limit; empty rungs are skipped; if nothing above the current rung survives, the turn escalates to the operator instead of leaking. Unknown or unclassified providers default to `cloud` — the worst-case assumption, so misconfiguration fails closed. A skill's `routing.sensitivity` maps to a maximum zone via a small tenant-editable table (e.g. `confidential → hai`, `internal → region`, `public → cloud`), so privacy triggers from the skill declaration, not operator vigilance.

### Client controls: two sliders and one hard limit

The client-facing control panel is exactly three controls, mapping deterministically onto ladder parameters — no optimizer, no scoring function to explain:

- **Sovereignty** (dropdown: `local | hai | region | cloud`) — a **hard limit, never a slider**. Compliance cannot be "70% important"; a tradeoff weight on data residency is meaningless to a DPO and indefensible in an audit. This is also the sales line: *„Datenschutz ist bei uns kein Schieberegler."*
- **Quality ↔ Price** (slider) — moves the start rung up and makes escalation more eager (fewer retries before stepping up).
- **Speed ↔ Price** (slider) — reorders models *within* a rung by measured latency/throughput instead of €/Mtok (same lever as OpenRouter's `:nitro`, but per rung).

Price needs no slider: it is the resting state of the mechanism — start low, order by cost.

## 3. What "routing by agent / by skill" exactly means — feasibility check

**By agent = feasible today, zero core plumbing.** The shipped `'routing'` middleware hook already receives `agentId`, `source`, `channelType`, `isInteractiveSource`, `explicitModelPinned`, session/model state and the user content (verified: `src/gateway/gateway-chat-service.ts:1280-1297`). A routing plugin can therefore resolve per-agent config (start tier, max tier, budget) with no gateway changes. Concretely it means: the invoice-extraction coworker starts on `small`, the strategy coworker starts on `frontier` — same ladder, different rung.

**One real catch (must fix):** `explicitModelPinned` (`gateway-chat-service.ts:1272-1277`) is true whenever the agent has *any* configured default model — which most agents do — and the existing concierge router skips pinned turns. As is, routing would silently disable itself for configured agents. Fix: an agent's default model counts as a *start-rung preference*; only a per-request model, a session `/model` override, or onboarding pinning remain hard pins. Small, contained change (G8 below).

**By skill = feasible, means two specific things — and one thing it does *not* mean.** A skill declares in its manifest (schema home verified: `SkillManifest`, `src/skills/skill-manifest.ts:45`):

- `routing.minTier` — a capability floor: "this job needs at least `standard`". Applied at the moment the skill is invoked (skill command / skills-hub selection — both are explicit code points), and kept for the sticky window.
- `routing.sensitivity` — a data constraint: "this skill touches client data", which triggers the privacy filter automatically instead of relying on operator vigilance.

What skill routing does **not** mean: per-turn detection of "which skill is driving this turn" mid-conversation. Once skill instructions blend into context, that attribution is guesswork; we don't build on it. Floor-at-invocation covers the real cases honestly.

**System turns** need no new machinery at all: heartbeat/scheduler/fullauto are already distinguishable in the hook context, and the 13 auxiliary tasks (titles, compaction, judges, memory flush …) already have their own per-task model config — Phase 1 just points their defaults at the bottom tier.

## 4. What "doesn't work → try higher" exactly means

Escalation triggers must be **deterministic and observable** — v1 uses only:

| Trigger | Detection | Exists? |
|---|---|---|
| Provider/model hard error (rate limit, auth, 5xx) | already classified by the fallback engine (`container/shared/provider-fallback.js`) | ✅ within-tier; across-tier is the new bit |
| Malformed tool call / unparseable required structured output | schema validation at the tool boundary | ✅ validators exist; wiring to escalation is new |
| Empty output, or narrate-only turn (a plan but no action and no answer) | one cheap retry, then escalate | pattern specced in roadmap R60; small guard |
| Operator says so | `/escalate` (or `/model`) | `/model` ✅; `/escalate` trivial |

v2 adds *quality* signals once telemetry exists: sampled judge verdicts on low-tier outputs, user retry/thumbs-down. Not v1 — quality judging must not gate the hot path before it's calibrated.

## 5. Current substrate and gaps (audited 2026-07-17)

Exists and is load-bearing: the `'routing'` middleware hook + model-override plumbing (`gateway-chat-service.ts:1279-1398`); the shipped `concierge-router` plugin (urgency→model routing — the fork template, `plugins/concierge-router/`); per-task auxiliary model config (`src/providers/task-routing.ts`); **named local endpoints** — models addressed as `<endpointName>/<modelId>` (`src/providers/local-types.ts:39`), so haigpu1/haigpu2 register as config, no code; within-tier fallback + cooldowns (`src/gateway/provider-fallback.ts:197`); tamper-evident per-model usage/cost accounting (`src/usage/token-usage-buffer.ts:226`, `model-cost.ts`). Backend (`~/src/chat`): named vLLM endpoint map (`VLLM_ENDPOINTS`), DB per-model EUR pricing, per-plan `token_budget_eur`, EUR metering ledger, OpenAI-compatible API.

| # | Gap | Where |
|---|---|---|
| G1 | Local/vLLM models hardcoded to €0 cost — blocks honest savings math + chargeback | `src/providers/local-types.ts:24` |
| G2 | Agent-turn path bypasses the fallback engine — escalation/failover unwired for real turns | `container-runner.ts` / `host-runner.ts` |
| G3 | `AgentModelConfig.fallbacks` dead schema field — remove (tiers supersede it) | `agent-registry.ts:617` |
| G4 | No per-spawn tier override — a planner can't force a subagent onto a low rung | `gateway-service.ts:11203/11287` |
| G5 | No `routing.minTier`/`sensitivity` in skill manifest | `src/skills/skill-manifest.ts:45` |
| G6 | Concierge's classifier is a remote LLM call (5s timeout) — the tier ladder must stay deterministic on the hot path | `plugins/concierge-router/` |
| G7 | Backend: static per-bot model, dormant `model2` fallback column, no GPU health checks, vLLM adapters strip tool definitions | `modules/llm/routes.py:1346-1560`, `adapters/llm/providers/vllm.py` |
| G8 | `explicitModelPinned` treats an agent's default model as a pin → routing self-disables for configured agents | `gateway-chat-service.ts:1272-1277` |

## 6. Plan

**Phase 1 — the ladder (HybridClaw).** `routing.tiers` config; `zone` metadata on model/endpoint entries (unknown → `cloud`, fails closed); `tier-router` plugin (forked from concierge-router, no classifier); escalation on the v1 triggers; system chores + aux tasks default to bottom tier; fix G1, G2, G3, G8; route fields (`tier`, `zone`, `reason`, `escalated`) on usage events; admin usage view shows **actual cost vs. all-on-top-tier counterfactual**. *Exit: a real session runs cheap-with-escalation and the cost report proves the saving.*

**Phase 2 — agent & skill knobs.** Per-agent `start`/`max` tier; the `sovereignty` limit with rung filtering + operator escalation on exhaustion; skill manifest `minTier`/`sensitivity` (G5) applied at invocation, sensitivity→zone mapping table; per-spawn subagent tier (G4); the two preference sliders (quality→start rung + escalation eagerness; speed→within-rung ordering by measured latency); budget clamp (needs the open R5 enforcement work); `/escalate`; sticky window. *Exit: each of the four client knobs demoable on the real fleet.*

**Phase 3 — enterprise & market (`~/src/chat`).** Tier bindings + endpoint health/failover server-side (revive `model2`, fix tool-stripping — G7); per-plan routing policy + admin surface + managed push-down; per-tier columns on the metering ledger; **client-facing savings dashboard** („Routing hat Ihnen diesen Monat €X gespart"); plan matrix (e.g. Starter = local-heavy best-price · Business = quality/price + budget · Sovereign = local/EU-only). Optional extensions, only if pull exists: mask-then-route (R4 masking lets a masked turn use a cloud tier in sovereign mode), and a small *local* classifier as a smarter first guess — the deterministic ladder is the product; a classifier is an optimization, never a dependency.

## 7. Market snapshot — why this wins DACH

Commercial routers route **stateless API requests**: [OpenRouter](https://openrouter.ai/blog/insights/model-routing/) (`:floor`/`:nitro`/`max_price`, Auto Router powered by [Not Diamond](https://www.notdiamond.ai/), 20–40% typical savings), Martian (governance angle; powers Accenture's Switchboard servicing >$1B of GenAI deployments — the category monetizes), [AWS Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-routing.html) (within one model family only, ~30%), [Azure Foundry router](https://techcommunity.microsoft.com/blog/educatordeveloperblog/microsoft-foundry-model-router-a-developers-guide-to-smarter-ai-routing/4502133) (Azure pool only), [EUrouter](https://www.eurouter.ai/providers) (EU residency, no intelligence). EU platforms with the trust story ([Langdock, Aleph Alpha, IONOS](https://innfactory.ai/en/blog/gdpr-compliant-ai-platforms-enterprise-comparison-2026/)) have model *choice*, not per-turn routing.

Nobody has all three of: **(1)** your own GPUs as first-class rungs in the same ladder as cloud models (DACH Mittelstand has on-prem hardware and wants it used), **(2)** agent/skill context steering the rung deterministically instead of a content classifier guessing, **(3)** every routing decision hash-chain-audited — which turns EU-AI-Act/DSGVO pressure into the buying reason instead of the blocker. And the escalation ladder is self-correcting by construction: a misconfigured floor costs one retry, not a wrong answer.

### Closest technical prior art: ACRouter ([agent-as-a-router](https://github.com/LanceZPF/agent-as-a-router), arXiv 2606.22902)

The strongest academic reference — and, encouragingly, a *convergent* design: its deployed runtime "routes one programming problem through an OpenRouter/OpenAI-compatible model list until a verifier passes" (`cheap_chain` → `escalate_to`), i.e. exactly our ladder. Where we differ, and why:

| | ACRouter | This design |
|---|---|---|
| Scope | single coding tasks (CodeRouterBench, ~10k instances, 8 API models) | every agent turn — chores, tools, multi-turn sessions, any domain |
| First-guess decision | trained router (Qwen3.5-8B LoRA) + an Orchestrator/Verifier/Memory loop reading the prompt — because a standalone router *only has* the prompt | deterministic runtime context (turn origin, skill floor, agent rung, budget, zone) — zero model calls, ~0 ms |
| Learning signal | memory of per-task-dimension performance stats; their headline: adding execution-grounded stats to a vanilla LLM router → **+15.3% relative** | the same insight, already in our substrate: R3 scoreboard (skill × model outcomes) biases the start rung in Phase 3 |
| Escalation | verifier-passes loop (empirically validated — their lowest cumulative regret comes from this, not from clever first guesses) | same pattern, with named deterministic v1 triggers |
| Economics | `Perf/$` over API prices | real €/Mtok including own GPUs — can express "our hardware is near-free at the margin" |
| Privacy | **absent** — no residency or locality concept | zones as a hard first-class axis |
| Maturity | MIT research artifact | production design on shipped substrate |

What we adopt from it: the replay-benchmark methodology (their CodeRouterBench replay → our HC-RouteBench from logged trajectories, Phase 3), the empirical case for verifier-escalation over router-cleverness, and — optionally, later — their LoRA-router recipe as the "smarter first guess", served on our own bottom tier. What we don't: their router as a dependency, or any LLM call on the routing hot path.

## 8. Anti-goals

No remote LLM call on the routing hot path. Never break a pin, a privacy limit, or a stakes/approval policy to save money. No quality-signal gating before telemetry is calibrated. No hardcoded tier names, tier count, or hardware anywhere in code. The OSS router is fully functional standalone (any two self-hosted endpoints form a ladder); the enterprise layer sells fleet operations, policy, dashboards, and guarantees — not the mechanism.
