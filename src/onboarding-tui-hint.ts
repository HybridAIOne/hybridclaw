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
  if (tokens.length < 2) return false;
  if (tokens[1] === 'onboarding') return true;
  return tokens[1] === 'auth' && tokens.length >= 3 && tokens[2] === 'login';
}
