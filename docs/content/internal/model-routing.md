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
  "target": { "quality": 0.5, "speed": 0.3 }  // one point on the Quality×Speed plane
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

### Client controls: one hard limit, one 2D target

The client-facing control panel is exactly two controls, mapping deterministically onto ladder parameters — no optimizer, no scoring function to explain:

- **Sovereignty** (dropdown: `local | hai | region | cloud`) — a **hard limit, never a slider**. Compliance cannot be "70% important"; a tradeoff weight on data residency is meaningless to a DPO and indefensible in an audit. This is also the sales line: *„Datenschutz ist bei uns kein Schieberegler."*
- **The target** — one draggable point on a **Quality × Speed plane**. The same plane plots the fleet's models at their *measured* positions (quality score × tokens/sec), colored by zone, with models outside the sovereignty limit grayed out — so the client literally sees what the router sees. Corner presets name the four natural postures: *Sparsam* (bottom-left), *Gründlich* (top-left), *Schnell* (bottom-right), *Premium* (top-right).

**Price is not a third control — it is the consequence**, displayed live next to the pad as a projected monthly € at current usage. Dragging toward any corner but bottom-left visibly raises it. Under the hood the pad stores exactly two floats (`target.quality`, `target.speed`): quality moves the start rung and escalation eagerness; speed reorders models within a rung by measured latency (the `:nitro` lever, per rung). The pad is UI over the same two parameters — the mechanism stays one sentence.

### The savings number: „Durch Routing gespart"

One honest, per-turn-computed metric, aggregated everywhere: for every turn, the **counterfactual cost** = the same prompt/completion tokens priced at the tenant's **reference model** (default: the primary model of the highest allowed rung — i.e. "what you'd have paid running everything on the big model", which is the client's actual mental baseline). **Saved by routing = Σ(counterfactual − actual)**, where *actual* includes escalation retries and duplicated attempts — the number is not allowed to flatter itself, and it is always displayed next to the escalation rate and quality signals so savings can never quietly hide quality erosion. Surfaces: per-session cost footer („diese Aufgabe: €0,42 statt €1,85"), per-agent card, and the tenant dashboard headline with monthly trend. Because it's computed per turn from the same usage events the hash-chain audit records, the € figure is *nachweisbar* — every cent of claimed savings traces to logged routing decisions.

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

## 6. Implementation plan — five testable phases

Each phase is independently shippable (1–3 PRs), carries its own tests, and has one measurable exit gate. File as R50.x sub-issue rows. A phase does not start until the previous phase's exit gate is green.

### R1 — Tier substrate: config, zones, honest costs *(hybridclaw)*

**Build:** `routing.tiers` schema (ordered tiers → ordered model lists), `zone` on model/endpoint entries (unknown → `cloud`), `defaultStart`, `escalationStickyTurns`; real €/Mtok on local endpoints (G1) flowing through `model-cost.ts`; a pure `resolveLadder(config, ctx)` helper; route fields (`routeTier`, `routeZone`, `routeReason`, `escalated`) on `TokenUsageEvent` (emitted empty until R2); delete dead `AgentModelConfig.fallbacks` (G3). No live routing behavior changes yet.
**Tests:** schema validation rejects unknown model refs, duplicate tier names, empty ladders; zone defaulting fails closed (unclassified provider → `cloud`); `resolveLadder` decision-table unit tests; a haigpu1 usage event records non-zero € (regression — today the rollup shows $0 for 10M tokens); counterfactual pricing unit tests (same tokens at top rung, escalation overhead included, never flattering).
**Exit gate:** the live instance's admin usage rollup shows real € for local-fleet traffic.

### R2 — The ladder runs: deterministic routing + escalation *(hybridclaw)*

**Build:** `tier-router` middleware plugin (concierge-router fork, zero remote calls on the hot path): system-turn taxonomy (heartbeat/scheduler/fullauto + the 13 auxiliary tasks → bottom rungs), agent start rung, the v1 escalation triggers (provider errors via the existing fallback classification; malformed tool call; empty/narrate-only after one retry; `/escalate`), sticky window + de-escalation; wire agent turns through `callWithProviderFallback` (G2); fix pin semantics (G8 — agent default model becomes a start preference; request/session pins stay hard).
**Tests:** decision-table unit tests covering every taxonomy row (context features → rung); per-trigger escalation classification tests; fake-provider integration: cheap tier fails → next rung called exactly once, `route.escalated` emitted, sticky window honored; a pinned session is never rerouted; a heartbeat turn lands on the bottom rung.
**Exit gate:** a golden E2E session on the real fleet runs plan-on-frontier / execute-on-standard / review-on-frontier, and the session report shows the tier split plus the counterfactual saving.

### R3 — The knobs: agent, skill, sovereignty, target *(hybridclaw + console)*

**Build:** per-agent `routing.start`/`max`; skill `routing.minTier`/`sensitivity` (G5) applied at invocation; per-spawn subagent tier override (G4); sovereignty max-zone filter with F14 operator escalation on ladder exhaustion; sensitivity→zone mapping table; 2D target mapping (quality → start rung + escalation eagerness, speed → within-rung ordering by measured latency); budget clamp behind a flag until R5 budget enforcement lands; console surfaces — composer routing state, per-turn route chips, escalation notice, task cost footer (per the 2026-07-17 mockups).
**Tests:** precedence unit tests (pin > skill floor > agent start > default); the compliance test — a property test over the audit event stream asserting that with sovereignty=`hai` no model with zone > `hai` is ever called; ladder exhaustion → F14 pending approval and zero cloud calls recorded; target monotonicity (raising quality never lowers the start rung); console component snapshots for chips and footer.
**Exit gate:** a scripted demo matrix — one scenario per client knob (best price · budget · quality/speed target · sovereign) — passes on the real fleet.

Implementation status: delivered in config schema v37 and database schema v54.
The deterministic/unit, gateway boundary, persistence, delegation, and console
component suites cover the build and test requirements above. The real-fleet
demo remains an operational release check because it requires configured live
endpoints and credentials.

### R4 — Proof: replay bench + savings surfaces *(hybridclaw)*

**Build:** HC-RouteBench — a CLI that replays logged trajectories through all configured tiers offline, scores each with the same deterministic verifiers + F11 judge, and emits a per-turn matrix plus regret / cost-at-quality report; the admin dashboard metric row and routing rollup card; per-tier judge sampling and escalation-rate telemetry with alert thresholds.
**Tests:** bench determinism on a fixture trajectory set (golden-file output); savings aggregation reconciles against ledger fixtures to the cent; dashboard API contract tests; alert-threshold unit tests.
**Exit gate:** a one-page savings report from ≥1 week of real traffic in which every claimed € traces to logged route events — and the bench runs as a CI gate for any change to routing defaults. (This is also the point where HybridRouter's D1 training data starts accumulating for free.)

### R5 — Enterprise control plane *(`~/src/chat`)*

**Build:** zone column + tier bindings in the backend model catalog; GPU endpoint health + circuit breaker (transplant the sandbox-reconciler pattern) and revive the dormant `model2` as tier fallback; enable native tool calling on capable self-hosted adapters (G7); per-plan routing policy + admin surface + managed push-down (F17-style `managed_by_routing`); `auto` pseudo-model on the OpenAI-compatible API; the client-facing „Durch Routing gespart" dashboard computed from metering rows. Optional, on pull: mask-then-route (R4 masking unlocks cloud rungs in sovereign mode).
**Tests:** plan-policy clamp unit tests (e.g. Starter caps frontier escalations/day); circuit-breaker state-machine tests; integration — stop the haigpu vLLM container → breaker opens, traffic shifts to fallback, health endpoint reports it, clients see no 5xx; `auto` responses carry the routed model in metadata; cross-repo E2E — a policy change in the admin propagates to a managed instance's next turn.
**Exit gate:** a real tenant sees the savings number on hybridai.one, reconcilable against `UserTokenUsage`.

**Learned entry rung, when we get there** — full training roadmap in [hybridrouter-finetuning.md](./hybridrouter-finetuning.md); base model decided: Qwen3.5-0.8B (Apache-2.0). Summary recipe: the router is a *classifier, not a generator* — tiny models are format-brittle in generation (in-house: LFM tool calls needed prefix forcing) but solid as scorers. v0: the in-repo embedding substrate + a logistic head over deterministic features (ships as coefficients, ~1 ms CPU, no serving infra). v1: LoRA fine-tune (officially supported via [Unsloth/TRL for LFM2.5](https://docs.liquid.ai/lfm/fine-tuning/unsloth); Qwen3-0.6B under Apache-2.0 is the license-clean fallback — LFM Open License commercial terms need verification) with an ordinal 3-class head, served on the bottom tier. **Training data is manufactured, not collected:** production route events + verifier outcomes give partial labels (every escalation = "entry was too low"), and the censoring problem — a `frontier` success never reveals whether `standard` would have sufficed — is closed by **replaying logged turns through all tiers on our own GPUs** and labeling each with the lowest rung that passes verification. On a self-hosted fleet that replay costs ~electricity; API-bound competitors pay per token for the same matrix. Corpora are R4-masked before persisting and stay per-tenant on-prem — the router is trained on the client's own work, on our hardware, leaving nowhere.

## 7. Market snapshot — why this wins DACH

Commercial routers route **stateless API requests**: [OpenRouter](https://openrouter.ai/blog/insights/model-routing/) (`:floor`/`:nitro`/`max_price`, Auto Router powered by [Not Diamond](https://www.notdiamond.ai/), 20–40% typical savings), Martian (governance angle; powers Accenture's Switchboard servicing >$1B of GenAI deployments — the category monetizes), [AWS Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-routing.html) (within one model family only, ~30%), [Azure Foundry router](https://techcommunity.microsoft.com/blog/educatordeveloperblog/microsoft-foundry-model-router-a-developers-guide-to-smarter-ai-routing/4502133) (Azure pool only), [EUrouter](https://www.eurouter.ai/providers) (EU residency, no intelligence). EU platforms with the trust story ([Langdock, Aleph Alpha, IONOS](https://innfactory.ai/en/blog/gdpr-compliant-ai-platforms-enterprise-comparison-2026/)) have model *choice*, not per-turn routing.

Nobody has all three of: **(1)** your own GPUs as first-class rungs in the same ladder as cloud models (DACH Mittelstand has on-prem hardware and wants it used), **(2)** agent/skill context steering the rung deterministically instead of a content classifier guessing, **(3)** every routing decision hash-chain-audited — which turns EU-AI-Act/DSGVO pressure into the buying reason instead of the blocker. And the escalation ladder is self-correcting by construction: a misconfigured floor costs one retry, not a wrong answer.

### Closest technical prior art: ACRouter ([agent-as-a-router](https://github.com/LanceZPF/agent-as-a-router), arXiv 2606.22902)

The strongest academic reference — and, encouragingly, a *convergent* design: its deployed runtime "routes one programming problem through an OpenRouter/OpenAI-compatible model list until a verifier passes" (`cheap_chain` → `escalate_to`), i.e. exactly our ladder. Where we differ, and why:

| | ACRouter | This design |
|---|---|---|
| Scope | single coding tasks (CodeRouterBench, ~10k instances, 8 API models) | every agent turn — chores, tools, multi-turn sessions, any domain |
| First-guess decision | released runtime: none — always starts at the cheapest model and escalates; the paper adds a predictive entry via an optional offline-trained router (Qwen3.5-**0.8B** LoRA) + memory of per-dimension stats, because a standalone router *only has* the prompt | deterministic runtime context (turn origin, skill floor, agent rung, budget, zone) sets the entry rung up-front — zero model calls, ~0 ms |
| Learning signal | memory of per-task-dimension performance stats; their headline: adding execution-grounded stats to a vanilla LLM router → **+15.3% relative** | the same insight, already in our substrate: R3 scoreboard (skill × model outcomes) biases the start rung in Phase 3 |
| Escalation | verifier-passes loop (empirically validated — their lowest cumulative regret comes from this, not from clever first guesses) | same pattern, with named deterministic v1 triggers |
| Economics | `Perf/$` over API prices | real €/Mtok including own GPUs — can express "our hardware is near-free at the margin" |
| Privacy | **absent** — no residency or locality concept | zones as a hard first-class axis |
| Maturity | MIT research artifact | production design on shipped substrate |

What we adopt from it: the replay-benchmark methodology (their CodeRouterBench replay → our HC-RouteBench from logged trajectories, Phase 3), the empirical case for verifier-escalation over router-cleverness, and — optionally, later — their LoRA-router recipe as the "smarter first guess", served on our own bottom tier. What we don't: their router as a dependency, or any LLM call on the routing hot path.

## 8. Anti-goals

No remote LLM call on the routing hot path. Never break a pin, a privacy limit, or a stakes/approval policy to save money. No quality-signal gating before telemetry is calibrated. No hardcoded tier names, tier count, or hardware anywhere in code. The OSS router is fully functional standalone (any two self-hosted endpoints form a ladder); the enterprise layer sells fleet operations, policy, dashboards, and guarantees — not the mechanism.
