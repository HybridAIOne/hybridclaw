export interface CliSecretSetCommand {
  secretName: string;
}

const CLI_SECRET_SET_LINE_RE =
  /^\s*(?:[$>%#]\s*)?(?:[^\s"'`]+[/\\])?hybridclaw\s+secret\s+set\s+([A-Za-z_][A-Za-z0-9_.-]{0,127})\s+(.+)$/i;

export function detectCliSecretSetCommand(
  content: string,
): CliSecretSetCommand | null {
  for (const line of content.split(/\r?\n/)) {
    const match = CLI_SECRET_SET_LINE_RE.exec(line);
    if (!match) continue;
    const secretName = match[1]?.trim();
    const valueTail = match[2]?.trim();
    if (!secretName || !valueTail) continue;
    return { secretName };
  }
  return null;
}

export function renderCliSecretSetCommandWarning(
  command: CliSecretSetCommand,
): string {
  return [
    'I did not run or send that secret command to the model because it includes a credential. The credential was not stored.',
    '',
    `In the TUI, use \`/secret set ${command.secretName} <value>\`. From a shell, run \`hybridclaw secret set ${command.secretName} <value>\` outside chat.`,
  ].join('\n');
}
