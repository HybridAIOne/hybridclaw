// Mask the value in a `/secret set <NAME> <VALUE>` command so a plaintext secret
// never lingers in the chat transcript — neither the echoed user bubble nor the
// reloaded history. The real value is still sent to the gateway for execution;
// only the copy rendered (and copied) on the chat page is masked.
//
// Only `secret set` carries a plaintext value. `secret list`, `secret show`,
// `secret unset`, and `secret route` reference a secret by name rather than
// value, so they — and every non-command message — are returned unchanged.

const SECRET_MASK = '••••••';

// Matches an optionally-slash-prefixed `secret set <NAME> <VALUE>` line. The
// `m` flag anchors `^`/`$` per line so only the secret line of a multi-line
// message is touched, and the value (`\S.*`) stops at the newline. Group 1 is
// preserved; the value after it is replaced wholesale (it may contain spaces or
// quotes). Used only with `String.replace`, which is safe with a global regex.
const SECRET_SET_LINE = /^(\s*\/?secret\s+set\s+\S+\s+)\S.*$/gim;

export function redactSecretCommand(text: string): string {
  return text.replace(
    SECRET_SET_LINE,
    (_match, prefix) => `${prefix}${SECRET_MASK}`,
  );
}
