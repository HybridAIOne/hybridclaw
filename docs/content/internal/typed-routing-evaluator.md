# Unified routing and JEV evaluation

**Providers → Routing** (`/admin/models#routing-concierge`) owns one enable switch,
one tier ladder, classifier selection, routing mode, urgency preference, shadow
comparison and chat visibility. Save routing applies them together. Model assignments
exist only in tiers; ASAP, Balanced and No hurry are preferences.

Tiers run from lighter/faster to more capable. Difficulty supplies a minimum tier:
basic uses the first, standard the middle, advanced the last. Uncertain difficulty
uses the configured default. Manual escalation and sticky tiers remain minimums;
explicit model pins skip classification but cannot bypass local-only restrictions.

- Privacy admits only models marked local, including retry and fallback candidates.
- Speed takes the first eligible model in configured order.
- Cost minimizes known input-plus-output token rates across eligible models.
  Unknown prices are never treated as zero; this is a rate comparison, not a
  prediction of task token counts.
- Auto uses a Pareto frontier of configured speed order and known token rate.
  ASAP prioritizes order, No hurry prioritizes price, and Balanced minimizes equal
  normalized rank/cost scores. Tier order is a speed proxy, not measured latency.

The concierge can be rule-based (no classifier cost), JEV, or a catalog model.
Both AI classifier types assess difficulty, explicit urgency and sensitivity;
only the shared policy can choose a model. Unspecified urgency uses the preference.
Text classifiers return validated labels, not calibrated probabilities. JEV
returns distributions and confidence; low-confidence dimensions stay uncertain.

## Shadow comparison in chat

Select a rule-based or text-model concierge and enable **Compare JEV in shadow**.
The live router determines execution; JEV evaluates the same eligible prompt in
parallel. Chat tags show both decisions and separate classification costs. Expanded
details show difficulty, urgency, tier, proposed model, latency, usage and cost.
A failed shadow call cannot change the live route. No model is substituted for a
failed classifier. Missing usage/prices remain unavailable rather than zero.
Historical messages retain their recorded decisions and prices.

## JEV questions and disclosure

JEV uses `https://api.typesafe.ai/v1/systemone`. `JEV_API_KEY` comes from the
runtime secret store or gateway environment and never enters the console.
Profile and difficulty descriptions belong in Choice `criteria`; the selection
rule belongs in `instructions`; `state` is the current prompt. See the
[TypeSafe Choice documentation](https://docs.typesafe.ai/primitives/choice).

Classification excludes history, memory, system prompts, attachments and expanded
context. Local sensitive-content/instruction checks precede all classifier calls;
these checks are defense in depth, not comprehensive PII detection. Detected
sensitivity requires local execution in every mode. Privacy mode never calls a
cloud classifier. An empty eligible local ladder fails closed. Provider errors
are sanitized; HTTP failures expose only the status code, never bodies or keys.
These controls govern model routing, not independently authorized tool calls.

JEV cost uses $0.042 per million input tokens and free output, verified 2026-09-21
against [TypeSafe pricing](https://typesafe.ai/blog/introducing-system-one-models-and-jev).
Classifier overhead is included once in the chat total. Tiny costs retain eight
decimal places; incomplete pricing shows the known subtotal explicitly.

**Labs → Routing Evaluator** (`/admin/routing-evaluator`) compares JEV against a
chosen classifier with the same tier policy on a public sample. It never executes
either route or changes live selection. Sample consent is explicit and resets on
edits. Agreement is not accuracy; calibration and observed latency models remain
future evaluation work.
