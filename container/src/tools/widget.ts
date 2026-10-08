/**
 * `show_widget`: a small interactive view, such as a calculator with sliders,
 * a quiz or a comparison the user can weigh, that the HybridAI app shows
 * inside the chat under the reply. The tool only writes one HTML file into
 * `widgets/` and returns it as an artifact with its own media type; the app
 * tells a widget from a page by that type, never by the reply's words.
 */
import { createHash } from 'node:crypto';

import type { ToolDefinition } from '../types.js';

export const SHOW_WIDGET_TOOL = 'show_widget';
export const WIDGET_MIME_TYPE = 'application/vnd.hybridai.widget+html';
export const WIDGET_MAX_HTML_CHARS = 200_000;

export function widgetFilePath(title: string, html: string): string {
  const slug =
    title
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/ß/g, 'ss')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
      .replace(/-+$/, '') || 'widget';
  // Each version gets its own file, so an earlier reply keeps the widget it showed.
  const hash = createHash('sha256').update(html).digest('hex').slice(0, 8);
  return `widgets/${slug}-${hash}.html`;
}

export function runShowWidget(
  args: Record<string, unknown>,
  writeFile: (relativePath: string, contents: string) => void,
): string {
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  const html = typeof args.html === 'string' ? args.html.trim() : '';
  if (!title) throw new Error('`title` is required.');
  if (title.length > 80)
    throw new Error('`title` must be at most 80 characters.');
  if (!html) throw new Error('`html` is required.');
  if (html.length > WIDGET_MAX_HTML_CHARS) {
    throw new Error(
      `\`html\` must be at most ${WIDGET_MAX_HTML_CHARS} characters; put long material in a page instead.`,
    );
  }
  const relativePath = widgetFilePath(title, html);
  writeFile(relativePath, html);
  return JSON.stringify({
    success: true,
    path: relativePath,
    note: 'The app shows this widget in the chat right under your reply. Do not link or mention the file.',
    artifacts: [
      {
        path: relativePath,
        filename: `${title}.html`,
        mimeType: WIDGET_MIME_TYPE,
      },
    ],
  });
}

export const SHOW_WIDGET_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: SHOW_WIDGET_TOOL,
    description:
      'Show a small interactive view inside the chat, right under your reply: a calculator or what-if with sliders, a comparison the user can re-weigh, a quiz or flashcards, a diagram with a control that shows how something works, a colour palette, a recipe that scales by servings, a budget or bill split. Write it as an HTML fragment with inline CSS and JavaScript. It sends nothing over the network and keeps nothing between openings. Use it when trying things out explains better than text; answer in plain text otherwise.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description:
            "A short name in the user's language, such as `Sparrechner`. Shown when the widget opens full screen.",
        },
        html: {
          type: 'string',
          description:
            'The widget: HTML with inline <style> and <script>, all data inside it. No <html>, <head> or <body> needed.',
        },
      },
      required: ['title', 'html'],
    },
  },
};
