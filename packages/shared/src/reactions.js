/**
 * Emoji reactions on chat messages: the one-emoji check shared by the
 * gateway's reaction route and idea icons, so
 * model or client text never lands where a single emoji belongs.
 */

// ZWJ sequences, skin tones and flags count as one emoji.
const SINGLE_EMOJI_PATTERN =
  /^(?:\p{Regional_Indicator}{2}|\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|️|⃣)*(?:‍\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|️)*)*)$/u;

export function readSingleEmoji(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return SINGLE_EMOJI_PATTERN.test(text) ? text : '';
}
