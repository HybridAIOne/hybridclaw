import { chatContentText } from '@hybridclaw/shared/message-text';
import type { ChatMessageContent } from './types.js';

const RALPH_CHOICE_RE = /<choice>\s*([^<]*)\s*<\/choice>/gi;

export function parseRalphChoice(
  content: ChatMessageContent,
): 'CONTINUE' | 'STOP' | null {
  const normalizedContent = chatContentText(content).trim();
  if (!normalizedContent) return null;
  let match: RegExpExecArray | null = null;
  let lastChoice: string | null = null;
  while (true) {
    match = RALPH_CHOICE_RE.exec(normalizedContent);
    if (!match) break;
    lastChoice = (match[1] || '').trim().toUpperCase();
  }
  if (lastChoice === 'CONTINUE' || lastChoice === 'STOP') return lastChoice;
  return null;
}

export function stripRalphChoiceTags(
  content: ChatMessageContent,
): string | null {
  const normalizedContent = chatContentText(content).trim();
  if (!normalizedContent) return null;
  const stripped = normalizedContent
    .replace(RALPH_CHOICE_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (stripped) return stripped;
  return parseRalphChoice(content) === null ? normalizedContent : null;
}

export function buildRalphPrompt(
  taskPrompt: string,
  missingChoice: boolean,
): string {
  const punctuatedPrompt = /[.!?]$/.test(taskPrompt)
    ? taskPrompt
    : `${taskPrompt}.`;
  const lines = [
    `${punctuatedPrompt} (You are running in an automated loop where the same prompt is fed repeatedly. Only choose STOP when the task is fully complete. Including it will stop further iterations. If you are not 100% sure, choose CONTINUE.)`,
    '',
    'Available branches:',
    '- CONTINUE',
    '- STOP',
    '',
    'Reply with a choice using <choice>...</choice>.',
  ];
  if (missingChoice) {
    lines.push('');
    lines.push(
      'Your last response did not include a valid choice. Include exactly one: CONTINUE or STOP.',
    );
  }
  return lines.join('\n');
}
