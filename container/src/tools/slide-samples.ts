/**
 * The `show_slide_samples` tool — the look picker for a new slide deck. The
 * agent designs the deck's title slide in a few looks, each as an HTML slide
 * (or a picture); this renders them to PNG with headless Chrome and writes a
 * `[slide-samples]` line to stderr, which the gateway attaches to this tool's
 * progress event (like a browser frame), so the Hy app shows the pictures as a
 * card to pick from. The pick comes back as the user's next chat message.
 *
 * HTML, not a .pptx: hosted sandboxes carry Chrome for the browser tools but
 * not LibreOffice, which a .pptx would need to become a picture.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { resolveWorkspacePath, WORKSPACE_ROOT } from '../runtime-paths.js';
import type { ToolDefinition } from '../types.js';

const run = promisify(execFile);

export const SLIDE_SAMPLES_TOOL = 'show_slide_samples';
/** Stderr prefix the gateway reads; see `parseSlideSamplesLine`. */
export const SLIDE_SAMPLES_LOG_PREFIX = '[slide-samples] ';
export const SLIDE_FORMATS = ['powerpoint', 'google_slides'] as const;
export type SlideFormat = (typeof SLIDE_FORMATS)[number];

const SAMPLES_ROOT = path.join(WORKSPACE_ROOT, '.slide-samples');
const SAMPLES_KEEP = 6;
const MIN_LOOKS = 2;
const MAX_LOOKS = 4;
const TITLE_MAX = 40;
const NOTE_MAX = 120;
const QUESTION_MAX = 120;
const RENDER_TIMEOUT_MS = 30_000;
const MAX_PICTURE_BYTES = 5 * 1024 * 1024;
const PICTURE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const HTML_EXTENSIONS = new Set(['.html', '.htm']);
// The browser tools' Chrome first (`AGENT_BROWSER_EXECUTABLE_PATH` in the
// hosted image), then the names Chrome installs under.
const CHROME_NAMES = [
  'chrome-headless-shell',
  'chromium',
  'chromium-browser',
  'google-chrome',
];

export const SLIDE_SAMPLES_TOOL_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: SLIDE_SAMPLES_TOOL,
    description:
      'Before you build a new slide deck, let the user pick its look. Design the deck’s title slide in 2–4 clearly different looks, each as a self-contained 1280×720 HTML file (inline CSS, fonts and colours pptxgenjs can reproduce), then call this. The user’s app shows each slide as a picture with its title to pick from, and the format they want. Then stop: their next message names the look and format. Not for editing an existing deck or one with a given template.',
    parameters: {
      type: 'object',
      properties: {
        looks: {
          type: 'array',
          description: 'One entry per look, in the order to show them',
          items: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: `Short name of the look, at most ${TITLE_MAX} characters, e.g. "Calm and light"`,
              },
              note: {
                type: 'string',
                description: `Optional: one line on what sets it apart, at most ${NOTE_MAX} characters`,
              },
              slide: {
                type: 'string',
                description:
                  'Workspace path of the sample slide: a 1280×720 .html file, or a .png/.jpg picture of it',
              },
            },
            required: ['title', 'slide'],
          },
        },
        formats: {
          type: 'array',
          items: { type: 'string', enum: [...SLIDE_FORMATS] },
          description:
            'How the finished deck can be delivered. Add "google_slides" only when a Google connector tool can import a presentation into the user’s Drive. Default: ["powerpoint"]',
        },
        question: {
          type: 'string',
          description: `Optional heading for the card, in the user’s language, at most ${QUESTION_MAX} characters. Default: the app’s own`,
        },
      },
      required: ['looks'],
    },
  },
};

export interface SlideLook {
  title: string;
  note?: string;
  image: string;
}

export interface SlideSamplesLine {
  question?: string;
  looks: SlideLook[];
  formats: SlideFormat[];
}

interface RequestedLook {
  title: string;
  note?: string;
  slide: string;
}

function clip(value: unknown, max: number): string {
  const text =
    typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** The looks and formats the model asked for, or an error for it to fix. */
export function parseSlideSamplesArgs(
  args: Record<string, unknown>,
):
  | { looks: RequestedLook[]; formats: SlideFormat[]; question?: string }
  | { error: string } {
  const rawLooks = Array.isArray(args.looks) ? args.looks : [];
  const looks = rawLooks.map((raw): RequestedLook => {
    const look = (raw && typeof raw === 'object' ? raw : {}) as Record<
      string,
      unknown
    >;
    const note = clip(look.note, NOTE_MAX);
    return {
      title: clip(look.title, TITLE_MAX),
      ...(note ? { note } : {}),
      slide: typeof look.slide === 'string' ? look.slide.trim() : '',
    };
  });
  if (looks.length < MIN_LOOKS || looks.length > MAX_LOOKS) {
    return {
      error: `Give ${MIN_LOOKS} to ${MAX_LOOKS} looks, one sample slide each.`,
    };
  }
  if (looks.some((look) => !look.title)) {
    return { error: 'Every look needs a title.' };
  }
  const unknown = looks.find((look) => {
    const ext = path.extname(look.slide).toLowerCase();
    return !HTML_EXTENSIONS.has(ext) && !PICTURE_EXTENSIONS.has(ext);
  });
  if (unknown) {
    return {
      error: `The slide of "${unknown.title}" must be an .html file or a .png/.jpg picture.`,
    };
  }
  const requested = Array.isArray(args.formats) ? args.formats : [];
  const formats = SLIDE_FORMATS.filter((format) => requested.includes(format));
  const question = clip(args.question, QUESTION_MAX);
  return {
    looks,
    formats: formats.length > 0 ? formats : ['powerpoint'],
    ...(question ? { question } : {}),
  };
}

function pruneSamples(): void {
  let names: string[];
  try {
    names = fs.readdirSync(SAMPLES_ROOT).sort();
  } catch {
    return;
  }
  for (const name of names.slice(0, -SAMPLES_KEEP)) {
    fs.rmSync(path.join(SAMPLES_ROOT, name), { recursive: true, force: true });
  }
}

function chromeCandidates(): string[] {
  const configured = process.env.AGENT_BROWSER_EXECUTABLE_PATH?.trim();
  return configured ? [configured, ...CHROME_NAMES] : CHROME_NAMES;
}

/** One 1280×720 screenshot of an HTML slide, by the first Chrome found. */
async function screenshot(htmlPath: string, out: string): Promise<void> {
  const args = [
    '--headless',
    '--no-sandbox',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--window-size=1280,720',
    // Lets web fonts and images load before the picture is taken.
    '--virtual-time-budget=5000',
    `--screenshot=${out}`,
    pathToFileURL(htmlPath).href,
  ];
  for (const chrome of chromeCandidates()) {
    try {
      await run(chrome, args, { timeout: RENDER_TIMEOUT_MS });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (fs.existsSync(out)) return;
    throw new Error('Chrome wrote no picture');
  }
  throw new Error('no headless Chrome is installed');
}

/** The look's picture in `outDir`: an HTML slide rendered, a picture copied. */
async function samplePicture(
  slidePath: string,
  outDir: string,
  index: number,
): Promise<string> {
  const ext = path.extname(slidePath).toLowerCase();
  if (HTML_EXTENSIONS.has(ext)) {
    const out = path.join(outDir, `look-${index + 1}.png`);
    await screenshot(slidePath, out);
    return out;
  }
  if (fs.statSync(slidePath).size > MAX_PICTURE_BYTES) {
    throw new Error(`${path.basename(slidePath)} is larger than 5 MB`);
  }
  // A copy, so a later edit of the file does not change what the card shows.
  const out = path.join(outDir, `look-${index + 1}${ext}`);
  fs.copyFileSync(slidePath, out);
  return out;
}

export async function runSlideSamplesTool(
  args: Record<string, unknown>,
): Promise<{ ok: boolean; text: string }> {
  const parsed = parseSlideSamplesArgs(args);
  if ('error' in parsed) return { ok: false, text: `Error: ${parsed.error}` };
  const slides: string[] = [];
  for (const look of parsed.looks) {
    const slidePath = resolveWorkspacePath(look.slide);
    if (!slidePath || !fs.existsSync(slidePath)) {
      return {
        ok: false,
        text: `Error: ${look.slide} was not found in the workspace.`,
      };
    }
    slides.push(slidePath);
  }
  const outDir = path.join(
    SAMPLES_ROOT,
    `${Date.now()}-${randomUUID().slice(0, 8)}`,
  );
  fs.mkdirSync(outDir, { recursive: true });
  const images: string[] = [];
  try {
    for (const [index, slidePath] of slides.entries()) {
      images.push(await samplePicture(slidePath, outDir, index));
    }
  } catch (error) {
    fs.rmSync(outDir, { recursive: true, force: true });
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      text: `Error: the sample slides could not be shown (${reason.slice(0, 200)}). Pass .png pictures of them instead, or describe the looks in a short list and ask which one the user wants.`,
    };
  }
  pruneSamples();
  const line: SlideSamplesLine = {
    ...(parsed.question ? { question: parsed.question } : {}),
    looks: parsed.looks.map((look, index) => ({
      title: look.title,
      ...(look.note ? { note: look.note } : {}),
      image: images[index],
    })),
    formats: parsed.formats,
  };
  console.error(`${SLIDE_SAMPLES_LOG_PREFIX}${JSON.stringify(line)}`);
  const choice =
    parsed.formats.length > 1
      ? 'the look and whether they want PowerPoint or Google Slides'
      : 'the look';
  return {
    ok: true,
    text: JSON.stringify({
      shown: parsed.looks.map((look) => look.title),
      next: `The user's app now shows the ${parsed.looks.length} sample slides as pictures with their titles. Stop here: end your turn with one short line asking which one they like, without describing the looks again. Their next message names ${choice}; then build the whole deck as a .pptx in that look, with its colours, fonts and layout.`,
    }),
  };
}
