// An app-build seed is one chat message, but only the briefing (the part
// before the marker) is shown in the chat — the build directive after it is
// sent to the model as input but hidden from the bubble (see
// stripAppBuildDirective + message-block). The model still receives everything.
export const APP_BUILD_DIRECTIVE_MARKER = '\n\n<<<APP_BUILD_DIRECTIVE>>>\n';

/** Display helper: show only the briefing, hide the build directive. */
export function stripAppBuildDirective(content: string): string {
  const idx = content.indexOf(APP_BUILD_DIRECTIVE_MARKER);
  return idx === -1 ? content : content.slice(0, idx).trimEnd();
}

const CLIENT_NOTE =
  'Build one self-contained, fully client-side HTML file (no backend).';

const STACK_NOTE =
  'Default to React via CDN — load React, ReactDOM, and Babel standalone from a CDN and put your JSX in an inline <script type="text/babel"> so it stays a single HTML file. Use a different stack only if I ask.';

const DESIGN_NOTE =
  'Design it with care — if you have a frontend-design skill, use it; otherwise apply strong fundamentals (clear layout, sensible typography, responsive, accessible, modern).';

const PUBLISH_NOTE =
  'When you finish, the app is automatically published to my Apps gallery and opened as a preview with its own link — no external hosting needed, so just build it.';

const BUILD_NOTE = `${CLIENT_NOTE} ${STACK_NOTE} ${DESIGN_NOTE} ${PUBLISH_NOTE}`;

function compose(briefing: string, directiveLines: string[]): string {
  return `${briefing}${APP_BUILD_DIRECTIVE_MARKER}${directiveLines.join('\n')}`;
}

/**
 * Build the first chat message that kicks off an app-building conversation.
 * Only the briefing is shown; the directive (everything after the marker) is
 * input for the model. When the user gives an idea, the agent refines that
 * briefing rather than suggesting other apps.
 */
export function buildAppSeed(
  categoryNoun: string | null,
  description: string,
): string {
  const desc = description.trim();
  if (desc) {
    const briefing = categoryNoun
      ? `Let's build a ${categoryNoun} web app. Here's my idea: ${desc}`
      : `Let's build a web app. Here's my idea: ${desc}`;
    return compose(briefing, [
      "Don't ask me a list of questions — use best-practice defaults for anything I didn't specify, and don't suggest a different app (I already know what I want).",
      `First propose a short plan (your key decisions, a few bullets), then wait for my OK and build it. ${BUILD_NOTE}`,
    ]);
  }
  const briefing = categoryNoun
    ? `Let's build a ${categoryNoun} web app.`
    : "Let's build a web app.";
  return compose(briefing, [
    'Ask me one quick question about what I want, then propose a short plan, wait for my OK, and build it.',
    BUILD_NOTE,
  ]);
}

/**
 * Seed for a "live app". Live apps assume the available MCP connectors / tools
 * and use them directly (no "which data source?" questions). With an idea the
 * agent confirms the needed connectors and refines the briefing; without one it
 * suggests connector-powered options.
 */
export function buildLiveAppSeed(description: string): string {
  const desc = description.trim();
  const liveTail = `build it as a live app that embeds the latest data pulled from those connectors, with a refresh action. ${BUILD_NOTE}`;
  const mcpRule =
    'Assume my connected MCP servers / tools are the data source: if a relevant connector is available, use it directly to fetch the data — do not ask me which data source or connector to use.';
  if (desc) {
    return compose(
      `I want to create a live app that uses my connected tools. Here's my idea: ${desc}`,
      [
        mcpRule,
        "Don't ask me a list of questions — use best-practice defaults for anything I didn't specify (scope, fields, sorting, refresh), and don't suggest a different app (I already know what I want). Tell me only if something essential is missing.",
        `First propose a short plan (your key decisions, a few bullets), then wait for my OK and ${liveTail}`,
      ],
    );
  }
  return compose('I want to create a live app that uses my connected tools.', [
    mcpRule,
    'Suggest the most useful live app or dashboard you can build with my connectors (briefly list a couple of options and recommend one).',
    `Once I pick, propose a short plan, wait for my OK, and ${liveTail}`,
  ]);
}
