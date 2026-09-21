# Typed routing evaluator — phase 2

The evaluator produces version-1 metadata independently of execution. It classifies
PII, confidentiality, task category, capability, and urgency (including unspecified)
in one JEV Choice request. Each dimension has a closed vocabulary, probabilities,
and confidence. Results include provider, returned model version, duration,
reported token usage, and a recommendation. Costs remain unknown; no price is
invented. The provider-independent `TypedClassifier` interface accepts the same
input and returns the same distributions for a future self-hosted adapter.

## Operator workflow

1. Open **Providers → Routing evaluator** (`/admin/models#routing-evaluator`).
2. Create `JEV_API_KEY` in **Secrets**. The key stays in the existing encrypted
   runtime store; the evaluator also accepts the gateway environment variable.
3. Use the playground examples. Without explicit public-sample confirmation, a
   sample is checked locally and never sent externally. Confidential and injection
   examples remain blocked even with that confirmation. No real secrets are needed.
4. Select **Shadow**, save, and evaluate a public sample. Expand dimensions to
   inspect probabilities, confidence, token usage, latency, and the recommended tier.
5. Approve that exact public prompt for live evaluation and save. Enable chat routing
   visibility and send the same prompt in chat. Expanded routing details compare
   the recommendation with the model actually executed. Reload preserves evidence.
6. Select **Active** and save to let eligible recommendations raise the starting tier.
   The tier ladder must be enabled. Manual pins, higher existing starts, and concierge
   routing retain precedence. The evaluator cannot lower the starting tier.

The playground uses saved settings and evaluates in shadow mode even when live
mode is off. It never sends a chat request or changes a route. Editing a sample
clears its public confirmation. Approved live samples match the entire trimmed
prompt, not substrings or regular expressions. Removing approval takes effect on
the next turn. No evaluator behavior is enabled on upgrade.

## Disclosure and execution boundaries

Only a trusted admin action grants public-input eligibility. Prompt or document
instructions cannot approve themselves. Local checks run before key lookup and
transport. Media, expanded references, and transcribed audio exclude a turn. Only
the approved current prompt is sent; conversation history, recalled memory, system
prompts, tool output, and attachments are not part of the classifier request.
Local sensitive/instruction-pattern checks are defense in depth, not a complete
PII detector. An admin must only approve content that is actually public.

Blocked classification leaves the existing route unchanged. This phase does not
claim to enforce end-to-end data privacy for the underlying chat execution. The
Privacy/Speed/Cost/Auto policies and tool/delegation disclosure limits are later
phases. PII/confidentiality classifier findings cannot relax any routing limit.

## Decisions and failures

The starting defaults are off, `jev-latest`, 1500ms timeout, and 0.8 minimum
confidence. The threshold applies to PII, confidentiality, and capability; task
and urgency remain visible evidence. Timeout and confidence are operator-configurable. Basic capability
recommends the first tier, standard the middle tier rounded upward, and advanced
the final tier of the current ordered list; no names or tier count are hardcoded.
This is a transparent policy baseline, not a calibrated performance prediction.
Urgency and task category are visible evidence; existing concierge policy is not
replaced by an uncalibrated classifier.

Missing credentials, invalid JSON/distributions, errors, cancellations, and timeouts
leave execution on the existing route and produce explicit fallback reasons.
Uncertain/sensitive answers and low confidence produce no recommendation. Raw
provider errors are never displayed or logged. Requests use a fixed HTTPS endpoint,
do not follow redirects, and have bounded time and response-size checks.

Live classifier usage is recorded as auxiliary overhead in the existing per-turn
trace and usage ledger. Playground responses show their own reported usage and
latency; they are not attributed to a chat session. Per-response evaluation records
contain only closed labels and metadata, never prompts. The visibility switch hides
those records without disabling accounting. The admin playground is behind the
existing admin authentication boundary.

## Validation

Targeted tests cover external-call suppression for unapproved/restricted/contextual
inputs, explicit public approval, timeout and malformed-response fallback, closed
probabilities, arbitrary tier counts, shadow versus active behavior, pinned models,
usage overhead, persistence validation, configuration round trips, and admin input
validation. No live JEV request is needed to run these tests.

References: [Choice](https://docs.typesafe.ai/primitives/choice),
[HTTP API](https://docs.typesafe.ai/api).

## JEV as the concierge

In **Providers → Routing concierge**, select `JEV · Typed routing` and enable the
concierge. The option is disabled until `JEV_API_KEY` is available in the secret
store or gateway environment. Ordinary catalog models remain selectable as urgency
classifiers with configurable execution models for their three profiles.

Selecting and enabling JEV authorizes current prompt text for cloud classification,
independently of the evaluator playground's exact public-prompt list and mode.
The same local sensitive-content and attachment/context exclusions still apply;
these are not a comprehensive privacy filter. History, memory, and system prompts
are excluded. The evaluator's confidence and timeout settings still apply.

JEV chooses a starting tier from the admin ladder by capability. Tier routing must
be enabled. Explicit model pins skip the concierge; manual escalation and sticky
higher tiers cannot be lowered. Missing credentials, local denial, uncertainty,
and API failures retain the existing starting route. Chat tags show the actual
execution model alongside the applied or suggested tier, or the fallback reason;
expanded details retain the distributions and classifier usage.
