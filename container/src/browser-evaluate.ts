/**
 * `browser_evaluate`: run a JavaScript expression in the open page and hand
 * back its JSON value, or save it to a workspace file. Reading a long list or
 * the page's own JSON API takes one call instead of a snapshot per screen.
 *
 * The script runs as the page, with its cookies and storage, so it is refused
 * while a secret typed into the page is still there (until the URL changes).
 * NOT a sandbox for untrusted code: the approval policy decides whether the
 * call runs at all, and browser-tools.ts keeps private hosts out of reach.
 * Failed expressions stay failed; recovery guidance never replays page code.
 */
import { currentBrowserPage } from './browser-checkout.js';
import type { ToolDefinition } from './types.js';

export const BROWSER_EVALUATE_TOOL = 'browser_evaluate';

// The snapshot's cap: one evaluate never costs more context than a snapshot.
const MAX_INLINE_CHARS = 48_000;

const DOM_LOOKUP_GUIDANCE =
  'Use the current page snapshot or inspect the DOM to verify your target. Snapshot roles such as button do not guarantee a <button> tag. Check querySelector/find results before accessing properties, report a missing match explicitly, and stop ancestor traversal when parentElement is null.';

export interface BrowserEvaluateDeps {
  /** Runs the browser tool in this chat's session; its JSON output. */
  evaluate(args: Record<string, unknown>): Promise<string>;
  writeFile(userPath: string, contents: string): void;
}

export async function runBrowserEvaluate(
  args: Record<string, unknown>,
  deps: BrowserEvaluateDeps,
): Promise<string> {
  const expression = String(args.expression || '').trim();
  if (!expression) throw new Error('expression is required');
  if (currentBrowserPage().framesPaused) {
    throw new Error(
      'A secret was typed into this page, so page scripts are off until the browser leaves it. Use browser_snapshot here, or evaluate after the next page loads.',
    );
  }
  const output = JSON.parse(
    await deps.evaluate({
      expression,
      ...(typeof args.frame === 'string' ? { frame: args.frame } : {}),
    }),
  ) as Record<string, unknown>;
  if (output.success !== true) {
    const error = String(output.error || 'evaluation failed');
    const missingValue =
      /TypeError: Cannot read properties of (?:null|undefined)\b/.test(error);
    throw new Error(
      missingValue
        ? `${error}\nA lookup or ancestor traversal may have reached a missing value. ${DOM_LOOKUP_GUIDANCE} Use browser_snapshot if needed. Before retrying, check for effects the failed script may already have performed.`
        : error,
    );
  }
  const { result } = output;
  const savePath = String(args.path || '').trim();
  if (savePath) {
    // A string is the file itself (CSV, Markdown); anything else is JSON.
    const contents =
      typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    deps.writeFile(savePath, contents);
    return JSON.stringify({
      success: true,
      url: output.url,
      path: savePath,
      chars: contents.length,
      ...(Array.isArray(result) ? { count: result.length } : {}),
    });
  }
  const inline = JSON.stringify({ success: true, url: output.url, result });
  if (inline.length <= MAX_INLINE_CHARS) return inline;
  const text = typeof result === 'string' ? result : JSON.stringify(result);
  return JSON.stringify({
    success: true,
    url: output.url,
    result: text.slice(0, MAX_INLINE_CHARS),
    truncated: true,
    note: `Result truncated at ${MAX_INLINE_CHARS} of ${text.length} chars. Pass path to save all of it to a file.`,
  });
}

export const BROWSER_EVALUATE_TOOL_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: BROWSER_EVALUATE_TOOL,
    description:
      "Run a JavaScript expression in the current page and return its value as JSON. Promises are awaited, so `fetch('/api/items').then(r => r.json())` calls the page's own API with its cookies. For several statements use `(async () => { ...; return value; })()`. Use it to read lists, tables, or data from a rendered page in one call, and pass `path` to save a large result to a workspace file. It can change the page like a click can. " +
      DOM_LOOKUP_GUIDANCE,
    parameters: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description:
            'JavaScript expression evaluated in the page. Example: `[...document.querySelectorAll("h3")].map(h => h.textContent.trim())`.',
        },
        path: {
          type: 'string',
          description:
            'Optional workspace file to save the full result to instead of returning it. A string result is written as is (build CSV in the expression); other values as JSON.',
        },
        frame: {
          type: 'string',
          description:
            'Optional frame selector. Use "main" to target the main document again.',
        },
      },
      required: ['expression'],
    },
  },
};
