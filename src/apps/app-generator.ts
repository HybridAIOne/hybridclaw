import type { AppCategory } from '../memory/apps.js';
import { normalizeAppCategory } from '../memory/apps.js';
import { callAuxiliaryModel } from '../providers/auxiliary.js';

const APP_TITLE_MAX_CHARS = 80;
const APP_GENERATION_MAX_TOKENS = 16000;

const CATEGORY_GUIDANCE: Record<AppCategory, string> = {
  apps: 'an interactive web app or website',
  documents: 'a polished, well-typeset document or template',
  games: 'a playable browser game with clear controls and win/lose feedback',
  productivity:
    'a focused productivity tool (calculator, tracker, planner, dashboard)',
  creative: 'a creative, visually striking interactive piece',
  quiz: 'an interactive quiz or survey that scores or summarizes responses',
  scratch: 'whatever the user describes',
};

const SYSTEM_PROMPT = [
  'You are an expert front-end engineer that builds single-file web artifacts.',
  'Return ONE complete, self-contained HTML document and nothing else.',
  'Rules:',
  '- Output ONLY raw HTML. No markdown, no code fences, no commentary before or after.',
  '- The document MUST start with `<!DOCTYPE html>` and contain `<html>`, `<head>`, and `<body>`.',
  '- Inline all CSS in a <style> tag and all JavaScript in a <script> tag. No external build steps.',
  '- You MAY load libraries only from a public CDN (e.g. cdnjs, jsDelivr, unpkg) via <script>/<link>.',
  '- Do NOT call backend APIs, local files, or anything requiring secrets. It must work fully client-side, offline if possible.',
  '- Make it responsive, accessible, and visually polished. Include a clear <title>.',
  '- Keep everything in the single returned document.',
].join('\n');

export interface GenerateAppParams {
  description: string;
  category?: string | null;
  agentId?: string;
  model?: string;
  chatbotId?: string | null;
}

export interface GeneratedApp {
  title: string;
  html: string;
  category: AppCategory;
}

/**
 * Pull a complete HTML document out of a raw model response that may be wrapped
 * in markdown fences, prefixed with prose, or include `<think>` reasoning.
 */
export function extractHtmlDocument(raw: string): string | null {
  let text = String(raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '');

  // Prefer a fenced ```html block (take the largest such block).
  const fenceRe = /```(?:html|HTML)?\s*\n?([\s\S]*?)```/g;
  let best: string | null = null;
  for (const match of text.matchAll(fenceRe)) {
    const body = match[1]?.trim();
    if (body && (!best || body.length > best.length)) best = body;
  }
  if (best) text = best;

  const lower = text.toLowerCase();
  const docStart = lower.indexOf('<!doctype html');
  const htmlStart = lower.indexOf('<html');
  const start = docStart !== -1 ? docStart : htmlStart;
  if (start === -1) return null;
  const htmlEnd = lower.lastIndexOf('</html>');
  const end = htmlEnd !== -1 ? htmlEnd + '</html>'.length : text.length;
  const doc = text.slice(start, end).trim();
  return doc.length > 0 ? doc : null;
}

export function deriveAppTitle(html: string, description: string): string {
  const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
  const fromTitle = titleMatch?.[1]?.replace(/\s+/g, ' ').trim();
  const candidate =
    fromTitle ||
    description
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
  const cleaned = candidate.replace(/^["'`]+|["'`]+$/g, '').trim();
  if (!cleaned) return 'Untitled App';
  return cleaned.length > APP_TITLE_MAX_CHARS
    ? `${cleaned.slice(0, APP_TITLE_MAX_CHARS).trimEnd()}…`
    : cleaned;
}

export async function generateApp(
  params: GenerateAppParams,
): Promise<GeneratedApp> {
  const description = params.description.trim();
  if (!description) {
    throw new Error('An app description is required.');
  }
  const category = normalizeAppCategory(params.category);
  const userPrompt = [
    `Build ${CATEGORY_GUIDANCE[category]} based on this request:`,
    '',
    description,
    '',
    'Return the complete HTML document now.',
  ].join('\n');

  const result = await callAuxiliaryModel({
    // App generation reuses the general-purpose `second_opinion` auxiliary task
    // for model routing rather than introducing a dedicated config key.
    task: 'second_opinion',
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.model ? { fallbackModel: params.model } : {}),
    ...(params.chatbotId ? { fallbackChatbotId: params.chatbotId } : {}),
    fallbackEnableRag: false,
    maxTokens: APP_GENERATION_MAX_TOKENS,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
  });

  const html = extractHtmlDocument(result.content);
  if (!html) {
    throw new Error(
      'The model did not return a valid HTML document. Try refining the request.',
    );
  }
  return {
    title: deriveAppTitle(html, description),
    html,
    category,
  };
}
