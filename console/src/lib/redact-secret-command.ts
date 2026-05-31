// Mask the value in a `/secret set <NAME> <VALUE>` command so a plaintext secret
// never lingers in the chat transcript — neither the echoed user bubble nor the
// reloaded history. The real value is still sent to the gateway for execution;
// only the copy rendered (and copied) on the chat page is masked.
//
// Only `secret set` carries a plaintext value. `secret list`, `secret show`,
// `secret unset`, and `secret route` reference a secret by name rather than
// value, so they — and every non-command message — are returned unchanged.

const SECRET_MASK = '••••••';

// Matches an optionally-slash-prefixed `secret set <NAME> <VALUE>` line.
// Group 1 captures everything up to and including the whitespace after the
// secret name; group 2 is the value, which may contain spaces or quotes and is
// replaced wholesale.
const SECRET_SET_LINE = /^(\s*\/?secret\s+set\s+\S+\s+)(\S.*)$/i;

export function redactSecretCommand(text: string): string {
  if (!/secret\s+set/i.test(text)) return text;
  return text
    .split('\n')
    .map((line) =>
      line.replace(
        SECRET_SET_LINE,
        (_match, prefix) => `${prefix}${SECRET_MASK}`,
      ),
    )
    .join('\n');
}
