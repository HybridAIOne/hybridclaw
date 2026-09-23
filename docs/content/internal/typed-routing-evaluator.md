# Unified routing and JEV evaluation

**Models → Routing** (`/admin/model-routing`) owns one enable switch,
one tier ladder, classifier selection, routing mode, shadow
comparison and chat visibility. Save routing applies them together. Model assignments
exist only in tiers. Every selected privacy boundary must have an eligible configured model.

Both classifiers choose the lowest configured tier capable of completing the task.
They receive the same ordered tier names and descriptions. The recommended tier
is the minimum; configured mode, privacy eligibility, manual escalation
and sticky tiers determine execution. Invalid or low-confidence decisions use the
configured default. Explicit model pins skip classification but cannot bypass
local-only restrictions.

- Privacy selects the narrowest eligible hosting zone within the privacy boundary.
- Speed uses median successful tool-free execution times. With incomplete timing
  coverage, it keeps configured order rather than discarding unmeasured models.
- Cost minimizes known input-plus-output token rates; unknown prices are not zero.
- Auto uses the cost/time Pareto frontier when timing coverage is complete,
  otherwise configured order. Timings are estimates, not benchmarks.

The concierge can be rule-based (no classifier cost), JEV, or a catalog model.
Both AI classifiers answer only the tier question. Text classifiers return one
validated tier name; JEV returns one Choice with probabilities and confidence.
Neither classifier assesses urgency, personal data, confidentiality or task type.

## Shadow comparison in chat

Select the **1st router · Live** and an optional **2nd router · Compare**.
Both selectors default to unset. An unset live classifier uses the configured
starting tier. Selecting and saving a comparison model explicitly authorizes
classification of eligible live prompts; adding a JEV key alone does not.
The Labs evaluator mode and public-sample consent are separate controls.
The live router determines execution; the comparison router evaluates the same eligible prompt in
parallel with execution. Dispatch does not wait for the comparison; final accounting
waits for its bounded completion so usage is recorded on the same turn. Chat tags show both decisions and separate classification costs. Expanded
details show tier, proposed model, latency, usage and cost.
A failed shadow call cannot change the live route. No model is substituted for a
failed classifier. Missing usage/prices remain unavailable rather than zero.
Historical messages retain their recorded decisions and prices.

## JEV questions and disclosure

JEV uses `https://api.typesafe.ai/v1/systemone`. `JEV_API_KEY` comes from the
runtime secret store or gateway environment and never enters the console.
Configured tier descriptions belong in Choice `criteria`; the selection
rule belongs in `instructions`; `state` is the current prompt. See the
[TypeSafe Choice documentation](https://docs.typesafe.ai/primitives/choice).

Classification excludes history, memory, system prompts, attachments and expanded
context. Local sensitive-content/instruction checks precede all classifier calls;
these checks are defense in depth, not comprehensive PII detection. Detected
signals skip classification, retaining the configured execution boundary.
Attachments, oversized prompts and instruction signals also skip classification;
they do not force a pinned or routed turn onto a local model. Explicit privacy
boundaries still apply to classification, execution and fallback. An empty eligible
ladder fails closed. Provider errors
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

Chat shows the tier recommendation and JEV tier confidence, with local-only
privacy restrictions when applicable. Full tier probabilities remain in Labs.
The classifiers do not provide privacy detection; local disclosure checks and
configured privacy policy remain the boundary, with the limitations stated above.

## Review boundaries

Classifier disclosure guards control additional classifier calls; they are not a
sensitivity verdict and do not silently replace the saved execution boundary.
Explicit privacy limits still fail closed for live, shadow, pinned and fallback
models. Tests cover blocked transport, comparison opt-in, disabled-classifier
migration, invalid responses and a failed or pending shadow call. Latency samples
exclude failed and tool-using execution; partial timing coverage retains configured
order. Live-provider accuracy and latency calibration remain unverified.
