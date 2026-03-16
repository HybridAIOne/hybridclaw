function tokenizeCommandLabel(commandLabel: string): string[] {
  return commandLabel.trim().split(/\s+/).filter(Boolean);
}

export function resolveTuiCommandLabel(commandLabel: string): string {
  const tokens = tokenizeCommandLabel(commandLabel);
  if (tokens.length === 0) return 'hybridclaw tui';
  return `${tokens[0]} tui`;
}

export function shouldPrintTuiStartHint(commandLabel: string): boolean {
  const tokens = tokenizeCommandLabel(commandLabel).map((token) =>
    token.toLowerCase(),
  );
  return tokens[1] !== 'tui';
}
