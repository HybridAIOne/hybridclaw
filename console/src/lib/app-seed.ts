// The build flow mirrors the reference artifact experience: refine the
// briefing, propose a short plan and wait for confirmation, then build. Output
// is one self-contained HTML file (the gallery serves it in a sandboxed iframe,
// so it must be fully client-side), defaulting to React via CDN.
const CLIENT_NOTE =
  'Build one self-contained, fully client-side HTML file (no backend).';

const STACK_NOTE =
  'Default to React via CDN — load React, ReactDOM, and Babel standalone from a CDN and put your JSX in an inline <script type="text/babel"> so it stays a single HTML file. Use a different stack only if I ask.';

const DESIGN_NOTE =
  'Design it with care — if you have a frontend-design skill, use it; otherwise apply strong fundamentals (clear layout, sensible typography, responsive, accessible, modern).';

const PUBLISH_NOTE =
  'When you finish, the app is automatically published to my Apps gallery and opened as a preview with its own link — no external hosting needed, so just build it.';

const BUILD_NOTE = `${CLIENT_NOTE} ${STACK_NOTE} ${DESIGN_NOTE} ${PUBLISH_NOTE}`;

/**
 * Build the first chat message that kicks off an app-building conversation.
 * When the user provides an idea, the agent refines that briefing and clarifies
 * open points (it does NOT suggest different apps); otherwise it asks what to
 * build. Either way it proposes a plan, waits for confirmation, then builds.
 */
export function buildAppSeed(
  categoryNoun: string | null,
  description: string,
): string {
  const desc = description.trim();
  if (desc) {
    const intro = categoryNoun
      ? `Let's build a ${categoryNoun} web app. Here's my idea: ${desc}`
      : `Let's build a web app. Here's my idea: ${desc}`;
    return [
      intro,
      '',
      'Before building:',
      "1. Refine this briefing with me — clarify any open points and fill the gaps. Don't suggest a different app; I already know what I want.",
      '2. Propose a short plan and wait for my OK.',
      `Then build it. ${BUILD_NOTE}`,
    ].join('\n');
  }
  const intro = categoryNoun
    ? `Let's build a ${categoryNoun} web app.`
    : "Let's build a web app.";
  return [
    intro,
    '',
    'Before building:',
    '1. Ask me a couple of quick questions about what I want, the purpose, and who it is for.',
    '2. Propose a short plan and wait for my OK.',
    `Then build it. ${BUILD_NOTE}`,
  ].join('\n');
}

/**
 * Seed for a "live app". With an idea, the agent confirms the needed connectors
 * are available and refines the briefing (no alternative-app suggestions);
 * without one, it suggests connector-powered options. It then plans, confirms,
 * and builds an app that embeds live connector data and can be refreshed.
 */
export function buildLiveAppSeed(description: string): string {
  const desc = description.trim();
  const liveTail = `Then build it as a live app that embeds the latest data pulled from those connectors, with a refresh action. ${BUILD_NOTE}`;
  if (desc) {
    return [
      `I want to create a live app that uses my connected tools. Here's my idea: ${desc}`,
      '',
      'Before building:',
      '1. Check which connectors / MCP servers I have set up, and confirm the ones this app needs are available — tell me if something is missing or will not work.',
      "2. Refine this briefing with me and clarify any open points (which data source, which connector, scope). Don't suggest a different app; I already know what I want.",
      '3. Propose a short plan and wait for my OK.',
      liveTail,
    ].join('\n');
  }
  return [
    'I want to create a live app that uses my connected tools.',
    '',
    'Before building:',
    '1. Check which connectors / MCP servers I have set up.',
    '2. Suggest a few useful live apps or dashboards that use them, and ask me which to build.',
    '3. Refine the idea with me and propose a short plan; wait for my OK.',
    liveTail,
  ].join('\n');
}
