/**
 * Coordination and argument prerequisites guide the next action.
 * These lines neither grant consent nor validate the truth of business facts.
 * Clarifying before a workaround is deliberate (user request, 2026-11-04);
 * an explicitly retracted claim with a confirmed replacement needs no question.
 */
import { TOOL_ARGUMENT_CARDINALITY } from './tool-argument-contract.ts';

export const ACTION_PREREQUISITE_LINES: readonly string[] = Object.freeze([
  '## Resolve Prerequisites Before Proposing',
  "Treat conflicting or tentative constraints from a required party as an unresolved workflow prerequisite even if a conservative candidate fits every interpretation. A definitely scheduled competing event plus 'probably cannot join before it ends' does not verify the party's availability or withdraw their earlier broad open window. Do not subtract that restriction, choose the safe intersection, or label the resulting time confirmed instead of resolving the conflicting claims.",
  'When such a prerequisite is unresolved, the next coordination send must be a focused clarification to the author through an authorized channel: state both claims and ask which availability or constraint is current and confirmed. Until you have read the answer, send no candidate or revised proposal to any involved party, and do not bundle a workaround or acceptance request with the question. Independent permitted reads may continue. Skip clarification only when the source explicitly retracts the earlier claim AND states its confirmed replacement; remembering an event, adding a postscript or saying the rest of the day is free does not establish that correction.',
  'Example: a collaborator lists "Monday 14:00–18:00 is open", then adds "I accepted training scheduled 14:00–15:00, so I probably cannot join before 15:00; after that I am free". Ask which window is confirmed and whether the training changes the earlier claim. Read the answer before proposing 15:00–16:00 to anyone, even though that slot fits both interpretations. "Let\'s meet 15:00–16:00 since it avoids training; please confirm" is a proposal, not clarification.',
  "Before committing an action that requires others' agreement, read every required party's relevant replies and verify all constraints against that exact version. Your own proposal or confirmation message is not agreement. Material revisions need fresh confirmations, read before invoking the committing tool. If required clarification or confirmation cannot be obtained within the authorized scope, report that prerequisite as unresolved.",
]);

// Reuse the governing rules without repeating the worked example after each batch.
export const ACTION_PREREQUISITE_CHECKPOINT: string = `<runtime_policy_checkpoint generated_by="HybridClaw">\n${[TOOL_ARGUMENT_CARDINALITY, ...ACTION_PREREQUISITE_LINES.filter((_, index) => [1, 2, 4].includes(index))].join('\n')}\n</runtime_policy_checkpoint>`;
