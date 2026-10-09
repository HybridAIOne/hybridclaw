/**
 * The `proof` tool: after an action outside the sandbox, the model records what
 * shows it really worked (the confirmation email, the confirmation page or a
 * screenshot of it), or that it could not confirm it. `/receipts` reads the
 * call from the audit and shows it with the action's receipt; it believes a
 * proof only when a matching check ran after the action in the same turn
 * (`src/gateway/receipts-command.ts`).
 *
 * A screenshot is copied out of `.browser-artifacts/`, which the phone cannot
 * open, into `receipts/`, where it can; the result names the copy as `path`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { WORKSPACE_ROOT, WORKSPACE_ROOT_DISPLAY } from '../runtime-paths.js';
import type { ToolDefinition } from '../types.js';

export const PROOF_DIRECTORY = 'receipts';
const ARTIFACT_DIRECTORY = '.browser-artifacts';
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const TEXT_LIMIT = 300;

export const PROOF_TOOL_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: 'proof',
    description:
      'Record whether an action you took outside the sandbox (an order, booking, form, payment, sign-up or message) really worked, so its receipt shows the evidence. Call it once after the action, in the same turn, after you checked: find the confirmation email with the mail tools, or read or screenshot the page that confirms it. confirmed true needs that check: evidence "email" (with from and subject), "screenshot" (the path browser_screenshot returned) or "page" (what the page said). If you could not find proof, call it with confirmed false and say why; then tell the user plainly you could not confirm it, never that it is done. Not needed when a connector’s own tool did the action and reported success.',
    parameters: {
      type: 'object',
      properties: {
        confirmed: {
          type: 'boolean',
          description: 'true only when the check shows the action worked',
        },
        evidence: {
          type: 'string',
          enum: ['email', 'screenshot', 'page'],
          description: 'What shows it, when confirmed',
        },
        summary: {
          type: 'string',
          description:
            'What the evidence says, such as "Booking confirmed, reference K7Q2PL"; or, when not confirmed, why not, such as "No confirmation email yet"',
        },
        screenshot: {
          type: 'string',
          description:
            'For evidence "screenshot": the path browser_screenshot returned, under .browser-artifacts/',
        },
        from: {
          type: 'string',
          description:
            'For evidence "email": the sender’s address on the confirmation email',
        },
        subject: {
          type: 'string',
          description: 'For evidence "email": its subject',
        },
      },
      required: ['confirmed', 'summary'],
    },
  },
};

function text(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

// `.browser-artifacts/shot.png`, `/workspace/.browser-artifacts/shot.png` or
// `shot.png`, as a file inside the artifact folder.
function artifactPath(value: string): string | null {
  let relative = value.replace(/\\/g, '/').replace(/^\.\//, '');
  if (relative.startsWith(`${WORKSPACE_ROOT_DISPLAY}/`))
    relative = relative.slice(WORKSPACE_ROOT_DISPLAY.length + 1);
  const inside = relative.startsWith(`${ARTIFACT_DIRECTORY}/`)
    ? relative
    : `${ARTIFACT_DIRECTORY}/${relative}`;
  const root = path.join(WORKSPACE_ROOT, ARTIFACT_DIRECTORY);
  const resolved = path.resolve(WORKSPACE_ROOT, inside);
  if (!resolved.startsWith(`${root}${path.sep}`) || !fs.existsSync(resolved))
    return null;
  // Never a link out of the folder.
  const real = fs.realpathSync(resolved);
  return real.startsWith(`${fs.realpathSync(root)}${path.sep}`) ? real : null;
}

// The copy the phone can open, named so a later screenshot of the same name
// never replaces an earlier proof.
function proofScreenshotPath(source: string, now: number): string {
  return `${PROOF_DIRECTORY}/proof-${now}-${path.basename(source)}`;
}

export function runProofTool(
  args: Record<string, unknown>,
  now = Date.now(),
): {
  ok: boolean;
  text: string;
} {
  if (typeof args.confirmed !== 'boolean')
    return { ok: false, text: 'confirmed must be true or false.' };
  const summary = text(args.summary);
  if (!summary || summary.length > TEXT_LIMIT)
    return {
      ok: false,
      text: `summary must say in 1–${TEXT_LIMIT} characters what the evidence shows, or why there is none.`,
    };
  if (!args.confirmed) {
    return {
      ok: true,
      text: JSON.stringify({
        recorded: true,
        next: 'Tell the user plainly, in your first sentence, that you could not confirm it worked and what they can check; do not call it done.',
      }),
    };
  }
  let copy: string | null = null;
  const evidence = text(args.evidence);
  if (evidence === 'email') {
    if (!text(args.from) || !text(args.subject))
      return {
        ok: false,
        text: 'An email proof needs the from and subject of the confirmation email you read.',
      };
  } else if (evidence === 'screenshot') {
    const source = artifactPath(text(args.screenshot));
    if (!source || !IMAGE_EXTENSIONS.has(path.extname(source).toLowerCase()))
      return {
        ok: false,
        text: 'screenshot must be the path browser_screenshot returned, under .browser-artifacts/.',
      };
    copy = proofScreenshotPath(source, now);
    fs.mkdirSync(path.join(WORKSPACE_ROOT, PROOF_DIRECTORY), {
      recursive: true,
    });
    fs.copyFileSync(source, path.join(WORKSPACE_ROOT, copy));
  } else if (evidence !== 'page') {
    return {
      ok: false,
      text: 'evidence must be email, screenshot or page when confirmed is true.',
    };
  }
  return {
    ok: true,
    text: JSON.stringify({
      recorded: true,
      ...(copy ? { path: copy } : {}),
      next: 'The user sees this proof with the action’s receipt.',
    }),
  };
}
