// The build flow mirrors the reference artifact experience: gather
// requirements, propose a short plan and wait for confirmation, design with
// care, then ship a single self-contained HTML file (which the gallery serves
// in a sandboxed iframe — so it must be fully client-side).
const DESIGN_NOTE =
  'Design it with care — if you have a frontend-design skill, use it; otherwise apply strong fundamentals (clear layout, sensible typography, responsive, accessible, modern).';

const WEB_BUILD_STEPS = [
  'Before building:',
  '1. Ask me a couple of quick questions about the purpose and who it is for.',
  '2. Propose a short plan — what it does, how it works, and how it looks — and wait for my OK.',
  `Then build it as a single, self-contained, polished HTML file (inline CSS and JS, CDN libraries allowed, fully client-side with no backend) that I can preview. ${DESIGN_NOTE}`,
].join('\n');

const LIVE_BUILD_STEPS = [
  'Before building:',
  '1. Check which connectors / MCP servers I have set up.',
  '2. Suggest a few useful live apps or dashboards that use them, and ask me which to build.',
  '3. Propose a short plan and wait for my OK.',
  `Then build the one I pick as a single, self-contained, polished HTML file that embeds the latest data pulled from those connectors, so I can preview it and refresh it later. ${DESIGN_NOTE}`,
].join('\n');

/**
 * Build the first chat message that kicks off an app-building conversation.
 * Selecting a category (or running `/app <idea>`) starts a normal chat seeded
 * with this message, so the agent gathers requirements, plans, then builds.
 */
export function buildAppSeed(
  categoryNoun: string | null,
  description: string,
): string {
  const desc = description.trim();
  let intro: string;
  if (categoryNoun && desc) {
    intro = `Let's build a ${categoryNoun} as a web app. Here's the idea: ${desc}`;
  } else if (desc) {
    intro = `Let's build a web app. Here's the idea: ${desc}`;
  } else if (categoryNoun) {
    intro = `Let's build a ${categoryNoun}.`;
  } else {
    intro = "Let's build a small web app.";
  }
  return `${intro}\n\n${WEB_BUILD_STEPS}`;
}

/**
 * Seed for a "live app": the agent first inspects the user's connected tools
 * (MCP / connectors), suggests connector-powered apps, plans, then builds one
 * that embeds the latest data so it can be refreshed later.
 */
export function buildLiveAppSeed(description: string): string {
  const desc = description.trim();
  const intro = desc
    ? `I want to create a live app that uses my connected tools. Here's my idea: ${desc}`
    : 'I want to create a live app that uses my connected tools.';
  return `${intro}\n\n${LIVE_BUILD_STEPS}`;
}
