/**
 * Emoji reactions on chat messages: the agent's `react` tool and the one-emoji
 * check that the tool, the gateway's reaction route and idea icons apply, so
 * model or client text never lands where a single emoji belongs.
 */

export const REACT_TOOL_NAME = 'react';

// ZWJ sequences, skin tones and flags count as one emoji.
const SINGLE_EMOJI_PATTERN =
  /^(?:\p{Regional_Indicator}{2}|\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|️|⃣)*(?:‍\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|️)*)*)$/u;

export function readSingleEmoji(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return SINGLE_EMOJI_PATTERN.test(text) ? text : '';
}
