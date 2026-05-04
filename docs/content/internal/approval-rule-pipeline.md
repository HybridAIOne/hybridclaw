# Approval Rule Pipeline

The tool approval cascade is implemented as a policy-configured rule pipeline in
`container/src/approval-policy.ts`. Each rule receives a typed `ToolCallContext`
and either returns `NextRule` or a terminal `Decision`.

The default order is also the compatibility order. Workspaces may override
`approval.rule_order` in `.hybridclaw/policy.yaml`; unknown rule names are
ignored and missing built-in rules are appended in their default order.

## Default Order

1. `policy_reload` reloads `.hybridclaw/policy.yaml` if it changed and clears expired pending approvals.
2. `classify_action` classifies the tool call into an action key, base safety tier, intent, preview, path hints, host hints, write intent, and promotion metadata.
3. `fingerprint` builds the stable tool-call fingerprint from the tool name, action key, normalized preview, and normalized arguments.
4. `pinned_red` applies hard-coded pinned path safeguards plus `approval.pinned_red` policy rules.
5. `autonomy` resolves the autonomy level from action override, tool override, then policy default.
6. `safety_tier` raises pinned or red-classified actions to red and seeds the working base tier.
7. `stakes` runs the stakes classifier middleware and stores its score and middleware decision on the context.
8. `autonomy_override` raises `confirm-each` actions, or non-low-stakes actions under `low-stakes-autonomous`, to red approval.
9. `red_hard_deny` returns a policy denial for hard-denied red actions.
10. `red_one_shot` consumes one-shot approval fingerprints.
11. `red_session_trust` applies in-memory session trust for non-pinned actions.
12. `red_agent_trust` applies durable agent trust for non-pinned actions.
13. `red_workspace_trust` applies durable workspace allowlist trust for non-pinned actions.
14. `red_promotable` promotes repeat-approved promotable red actions to yellow.
15. `red_full_auto` allows full-auto mode to promote eligible red actions to yellow.
16. `red_queue` denies new approval requests when the pending queue is full.
17. `red_prompt` creates or reuses a pending approval request.
18. `yellow_full_auto` allows full-auto mode to approve eligible yellow actions.
19. `yellow_execution_promotion` promotes repeated non-sticky yellow actions to green, or marks first yellow execution as implicit.
20. `green_fallback` returns the final evaluation for all non-terminal paths.

The trust-store layout is unchanged: one-shot fingerprints, session trusted
actions/fingerprints, agent trusted actions/fingerprints, and workspace
allowlisted actions/fingerprints retain their existing storage.

## Hook Events

The pipeline emits `pre_tool_use` and `post_tool_use` hook events around each
rule through the rule context. The container runtime wires those events into
the F2 runtime event bus via `emitRuntimeEvent`, including `approvalRule`,
`toolName`, `actionKey`, and current `decision` when available. The plugin
event bus also exposes `pre_tool_use` and `post_tool_use` as first-class hook
names while preserving the older `before_tool_call` and `after_tool_call`
hooks.

Future approval extensions should add a named rule and place it through
`approval.rule_order` instead of editing the surrounding cascade.
