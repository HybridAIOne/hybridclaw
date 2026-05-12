# Approval Rule Pipeline

The tool approval cascade is implemented as a policy-configured rule pipeline in
`container/src/approval-policy.ts`. Each rule receives a typed `ToolCallContext`
and either returns `NextRule` or a terminal `Decision`.

The default order is also the compatibility order. Workspaces may list built-in
or registered external rules in `approval.rule_order` in
`.hybridclaw/policy.yaml`; unknown rule names warn and are ignored, missing
built-in rules are merged back in default order, and orders that violate
built-in dependencies fall back to the full default order. External rules can be
slotted between built-in anchors, for example between `stakes` and
`autonomy_override`.

## Default Order

1. `policy_reload` reloads `.hybridclaw/policy.yaml` if it changed and clears expired pending approvals.
2. `classify_action` classifies the tool call into an action key, base safety tier, intent, preview, path hints, host hints, write intent, and promotion metadata.
3. `fingerprint` builds the stable tool-call fingerprint from the tool name, action key, normalized preview, and normalized arguments.
4. `pinned_red` applies hard-coded pinned path safeguards plus `approval.pinned_red` policy rules.
5. `autonomy` resolves the autonomy level from action override, tool override, then policy default.
6. `safety_tier` raises pinned or red-classified actions to red and seeds the working base tier.
7. `stakes` runs the stakes classifier middleware and stores its score and middleware decision on the context.
8. `anomaly_reranker` scores the call against the agent's prior approved trajectories and elevates unusual green/yellow actions by one tier.
9. `autonomy_override` raises `confirm-each` actions, or non-low-stakes actions under `low-stakes-autonomous`, to red approval.
10. `red_hard_deny` returns a policy denial for hard-denied red actions.
11. `red_one_shot` consumes one-shot approval fingerprints.
12. `red_session_trust` applies in-memory session trust for non-pinned actions.
13. `red_agent_trust` applies durable agent trust for non-pinned actions.
14. `red_workspace_trust` applies durable workspace allowlist trust for non-pinned actions.
15. `red_promotable` promotes repeat-approved promotable red actions to yellow.
16. `red_full_auto` allows full-auto mode to promote eligible red actions to yellow.
17. `red_queue` denies new approval requests when the pending queue is full.
18. `red_prompt` creates or reuses a pending approval request.
19. `yellow_full_auto` allows full-auto mode to approve eligible yellow actions.
20. `yellow_execution_promotion` promotes repeated non-sticky yellow actions to green, or marks first yellow execution as implicit.
21. `green_fallback` returns the final evaluation for all non-terminal paths.

The trust-store layout is unchanged: one-shot fingerprints, session trusted
actions/fingerprints, agent trusted actions/fingerprints, and workspace
allowlisted actions/fingerprints retain their existing storage.

## Behavioral Anomaly Reranker

`anomaly_reranker` is a CPU-only v1 model. It reads scrubbed R10.1 trajectory
JSONL files for the current agent and trains an order-2 Markov chain plus a
frequency baseline over `(action_class, target_class, hour_bucket, tool)`
tuples. The model abstains until the agent has at least 50 approved
trajectories. The adaptive threshold is the agent's p99 training score.

Live calls are scored after `stakes` and before `autonomy_override`. Scores
above threshold elevate one tier (`green` to `yellow`, `yellow` to `red`).
Borderline scores within the configured epsilon call F11 trace-judge through
the `eval_judge` auxiliary task before any anomaly tier elevation. The normal
non-borderline path stays synchronous and does not make an LLM call.

Every structured tool-execution audit event includes `anomaly.score` and
`anomaly.reason`. The R3 scoreboard and generated `CV.md` render weekly
per-agent anomaly rollups.

The v1 model is intentionally simple. Upgrade candidates are HMMs for latent
task state, isolation forests over compact feature vectors, or a small
transformer over tokenized action sequences. These are not implemented because
the approval pipeline needs a deterministic, cheap default scorer.

## Hook Events

The pipeline emits `pre_tool_use` and `post_tool_use` hook events around each
rule through the rule context. The container runtime wires those events into
the F2 runtime event bus via `emitRuntimeEvent`, including
`kind: "approval_rule"`, `approvalRule`, `toolName`, `actionKey`, and current
`decision` when available.

The plugin event bus also exposes `pre_tool_use` and `post_tool_use` as
first-class hook names with `kind: "tool_execution"` while preserving the older
`before_tool_call` and `after_tool_call` hooks. Subscribers that listen to both
approval-rule and tool-execution events must filter on `kind`.

## External Rules

Approval extensions register named rules with `registerApprovalRule(ruleName,
rule)`. Registered names are accepted in `approval.rule_order`; the policy
loader keeps built-in prerequisites in their default relative order while
admitting external names between built-in anchors. A custom post-stakes
reranker can therefore register a rule and configure:

```yaml
approval:
  rule_order:
    - stakes
    - custom_reranker
    - autonomy_override
```
