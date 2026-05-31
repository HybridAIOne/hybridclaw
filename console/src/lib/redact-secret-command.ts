// Mask the value in a `/secret set <NAME> <VALUE>` command so a plaintext secret
// never lingers in the chat transcript — neither the echoed user bubble nor the
// reloaded history. The real value is still sent to the gateway for execution;
// only the copy rendered (and copied) on the chat page is masked.
//
// Only `secret set` carries a plaintext value. `secret list`, `secret show`,
// `secret unset`, and `secret route` reference a secret by name rather than
// value, so they — and every non-command message — are returned unchanged.

const SECRET_MASK = '••••••';

// Matches a message that *starts* with an optionally-slash-prefixed
// `secret set <NAME> <VALUE>`. Only a message beginning with the command is a
// secret-set command: the gateway tokenizes on all whitespace (newlines
// included) and treats everything after `<NAME>` as the value, so a value can
// span multiple lines when the composer sends Shift+Enter input. `[\s\S]*$`
// therefore masks the whole value through the end of the message — not just its
// first line. Group 1 (command + name) is preserved; the value is replaced
// wholesale (it may contain spaces, quotes, or newlines).
const SECRET_SET_VALUE = /^(\s*\/?secret\s+set\s+\S+\s+)\S[\s\S]*$/i;

export function redactSecretCommand(text: string): string {
  return text.replace(
    SECRET_SET_VALUE,
    (_match, prefix) => `${prefix}${SECRET_MASK}`,
  );
}
