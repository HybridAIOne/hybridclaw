/**
 * Opaque write hints complement actual redirect and destination inspection.
 * Certified literal patterns are data; unknown scripts retain the fallback.
 * Unlike the workspace fence, this identifies intent and grants no access.
 */
import { commandProgram, splitShellCommands } from './bash-commands.js';
import { shellLiteralDataArgs } from './bash-pinned-reach.js';

// `2>&1`, `>&2`, `2>&-`, /dev/null and comparisons are not file writes.
// Owner calls, 2026-09-27 and 2026-09-29: descriptor operations and discarded
// output do not raise the tier. Opaque write expressions remain conservative.
// Actual redirects remain covered by commandWriteTargets; opaque expressions
// keep the fallback, including embedded scripts this module cannot certify.
const WRITE_INTENT_RE =
  /\b(mkdir|touch|mv|cp|chmod|chown|tee)\b|(^|[^>])>>?(?!=)(?!(?:&(?:\d+|-)|&?\s*\/dev\/null)(?:$|[\s;|&)]))[^>]|sed\s+-i|perl\s+-pi/i;

export function hasBashWriteIntent(inspectionSurface: string): boolean {
  return splitShellCommands(inspectionSurface).some(({ words }) => {
    const { start, program, args, unresolvedPrefix } = commandProgram(words);
    const data = new Set(
      unresolvedPrefix ? [] : shellLiteralDataArgs(program, args),
    );
    return WRITE_INTENT_RE.test(
      words
        .map((word, index) =>
          data.has(index - start - 1) ? '__LITERAL_DATA__' : word,
        )
        .join(' '),
    );
  });
}
