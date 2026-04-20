import type { ChatMessage } from './types.js';

export interface QueuedSteeringNote {
  note: string;
  createdAt: string;
}

function normalizeSteeringNoteText(note: string): string {
  return String(note || '').trim();
}

function normalizedSteeringNotes(notes: QueuedSteeringNote[]): string[] {
  return notes
    .map((entry) => normalizeSteeringNoteText(entry.note))
    .filter(Boolean);
}

export function buildSteeringCheckpointPrompt(
  notes: QueuedSteeringNote[],
): string {
  const normalized = normalizedSteeringNotes(notes);
  if (normalized.length === 0) return '';

  const lines = [
    'Steering note from the user during the current turn. You reached a safe checkpoint after a tool or model step. Adjust course immediately and continue from the current state instead of restarting.',
    '',
    normalized.length === 1 ? 'User note:' : 'User notes:',
  ];

  if (normalized.length === 1) {
    lines.push(normalized[0]);
  } else {
    for (let index = 0; index < normalized.length; index += 1) {
      lines.push(`${index + 1}. ${normalized[index]}`);
    }
  }

  return lines.join('\n');
}

export function appendSteeringNotesToToolMessages(params: {
  history: ChatMessage[];
  notes: QueuedSteeringNote[];
  recentToolMessageCount: number;
}): string | null {
  const normalized = normalizedSteeringNotes(params.notes);
  if (normalized.length === 0 || params.recentToolMessageCount <= 0) {
    return null;
  }

  let targetIndex = -1;
  const earliestIndex = Math.max(
    params.history.length - params.recentToolMessageCount,
    0,
  );
  for (
    let index = params.history.length - 1;
    index >= earliestIndex;
    index -= 1
  ) {
    if (params.history[index]?.role === 'tool') {
      targetIndex = index;
      break;
    }
  }
  if (targetIndex < 0) return null;

  const lines = ['', '', '[USER STEER (injected mid-run, not tool output):'];
  if (normalized.length === 1) {
    lines.push(normalized[0]);
  } else {
    for (let index = 0; index < normalized.length; index += 1) {
      lines.push(`${index + 1}. ${normalized[index]}`);
    }
  }
  lines.push(']');
  const marker = lines.join('\n');

  const target = params.history[targetIndex];
  if (typeof target.content === 'string' || target.content == null) {
    target.content = `${target.content || ''}${marker}`;
    return marker;
  }

  target.content = [
    ...target.content,
    {
      type: 'text',
      text: marker.trimStart(),
    },
  ];
  return marker;
}

export function appendSteeringCheckpointMessage(params: {
  history: ChatMessage[];
  notes: QueuedSteeringNote[];
}): string | null {
  const prompt = buildSteeringCheckpointPrompt(params.notes);
  if (!prompt) return null;
  params.history.push({
    role: 'user',
    content: prompt,
  });
  return prompt;
}
