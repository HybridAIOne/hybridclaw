/**
 * Build the first chat message that kicks off an app-building conversation.
 * Selecting a category (or running `/app <idea>`) starts a normal chat seeded
 * with this message, so the agent gathers requirements and then builds a
 * self-contained web app — rather than one-shotting from a form.
 */
export function buildAppSeed(
  categoryNoun: string | null,
  description: string,
): string {
  const desc = description.trim();
  const tail =
    'Ask me any clarifying questions you need, then build it as a single self-contained web app and show me a preview.';
  if (categoryNoun && desc) {
    return `Let's build a ${categoryNoun} as a self-contained web app. Here's the idea: ${desc}\n\n${tail}`;
  }
  if (desc) {
    return `Let's build this as a self-contained web app: ${desc}\n\n${tail}`;
  }
  if (categoryNoun) {
    return `Let's build a ${categoryNoun}. Ask me a few quick questions about what I want, what it's for, and who it's for — then build it as a single self-contained web app I can preview.`;
  }
  return `Let's build a small self-contained web app. ${tail}`;
}

/**
 * Seed for a "live app": the agent first inspects the user's connected tools
 * (MCP / connectors), suggests connector-powered apps, then builds one that
 * embeds the latest data so it can be refreshed later.
 */
export function buildLiveAppSeed(description: string): string {
  const desc = description.trim();
  const intro = desc
    ? `I want to create a live app that uses my connected tools. Here's my idea: ${desc}`
    : 'I want to create a live app that uses my connected tools.';
  return [
    intro,
    '',
    'First, check which connectors / MCP servers I have set up.',
    'Then suggest a few useful live apps or dashboards that use them, and ask me which to build.',
    'Build the one I pick as a single self-contained web app that embeds the latest data pulled from those connectors, so I can preview it and refresh it later.',
  ].join('\n');
}
