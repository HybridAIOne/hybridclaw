import { spawnSync } from 'node:child_process';

import { mergeSystemMessage } from './system-messages.js';
import type { ChatMessage } from './types.js';

export interface RuntimeCapabilities {
  hasSoffice: boolean;
  hasPdftoppm: boolean;
}

let cachedCapabilities: RuntimeCapabilities | null = null;

function commandExists(command: string): boolean {
  if (!/^[A-Za-z0-9._-]+$/.test(command)) return false;
  const result = spawnSync(
    'sh',
    ['-lc', 'command -v -- "$1" >/dev/null 2>&1', 'sh', command],
    { stdio: 'ignore' },
  );
  return result.status === 0;
}

export function detectRuntimeCapabilities(): RuntimeCapabilities {
  if (cachedCapabilities) {
    return cachedCapabilities;
  }
  cachedCapabilities = {
    hasSoffice: commandExists('soffice') || commandExists('libreoffice'),
    hasPdftoppm: commandExists('pdftoppm'),
  };
  return cachedCapabilities;
}

export function buildRuntimeCapabilitiesMessage(
  capabilities: RuntimeCapabilities,
): string {
  return [
    '## Runtime Capabilities',
    `- LibreOffice \`soffice\`: ${capabilities.hasSoffice ? 'available' : 'unavailable'}`,
    `- \`pdftoppm\`: ${capabilities.hasPdftoppm ? 'available' : 'unavailable'}`,
    '- Use `skills/office/soffice.cjs` only when `soffice` is available.',
    '- Use `skills/pptx/scripts/thumbnail.cjs` only when both `soffice` and `pdftoppm` are available.',
    capabilities.hasSoffice && capabilities.hasPdftoppm
      ? '- For generated `.pptx` decks, run the render-and-review loop before final delivery: export, render thumbnails, review them, fix issues, and rerender until no concrete slide-level issues remain.'
      : '- Do not attempt PPTX render-and-review when either `soffice` or `pdftoppm` is unavailable. Skip that QA path silently unless the user explicitly asked for QA, PDF export, thumbnails, validation, or render verification.',
    '- Do not mention missing Office/PDF QA tools in the final reply by default. Mention the limitation only when the user asked for that QA/export step or when the limitation materially affects the requested outcome.',
    '- If a requested QA or export step is unavailable, say that once and continue with the best deliverable you can produce instead of surfacing tool error output.',
  ].join('\n');
}

export function injectRuntimeCapabilitiesMessage(
  messages: ChatMessage[],
  capabilities: RuntimeCapabilities = detectRuntimeCapabilities(),
): ChatMessage[] {
  return mergeSystemMessage(
    messages,
    buildRuntimeCapabilitiesMessage(capabilities),
  );
}

export function resetRuntimeCapabilitiesCache(): void {
  cachedCapabilities = null;
}
