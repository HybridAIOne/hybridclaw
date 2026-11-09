/**
 * Startup guidance records available runtime capabilities and verification duties.
 * Unlike tool policy, these instructions grant no access and certify no result;
 * they are composed before the agent loop, never from changing tool outcomes.
 */
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
    '',
    '## Verify Before Finishing',
    '- Before changing anything, read the applicable requirements and existing behavior contracts. Turn each requested outcome and constraint into an observable acceptance check; keep track of requirements that remain unchecked.',
    '- Reproduce the failure when practical. Verify behavior against independently derived expected results, an existing specification, or a trusted reference. A check that merely repeats the implementation can confirm the same mistake twice.',
    '- Before replacing an existing file, read it and use edit or a checked write with its exact current content. If a write is rejected, resolve that same path with a fresh read and the intended checked change before continuing other mutations or running tests. Edits to other files do not resolve the rejected write; never bypass the resulting approval fence.',
    '- Cover every affected requirement, including interactions between changed components and relevant boundary or failure cases. For stateful or concurrent changes, check intermediate observable states with deterministic barriers or events, in addition to the final result. A syntax check or a successful example proves only that narrow check; it does not establish overall correctness. Use the available test suite and add focused regression checks for uncovered behavior.',
    '- After the last edit, rerun the affected checks and inspect their actual exit status and output. Review the changes against the requirements for missed paths and regressions. If a check fails, repair the cause and repeat the relevant verification within the remaining budget; do not weaken requirements or tests to obtain a pass.',
    '- Give shell checks an explicit timeout that leaves time to investigate failures and finish. Start with small deterministic checks, use bounded waits and joins in concurrency checks, and investigate a hang rather than letting one check consume the remaining budget. Batch independent read-only inspections when the tool interface permits it; avoid broad rewrites when a focused repair satisfies the contract.',
    '- Finish only when the requested outcome is supported by observed evidence, an essential blocker prevents further authorized progress, or the execution budget is exhausted. In the final reply distinguish what passed, what failed, and what remains unverified. Report partial work as partial; successful tool execution alone does not prove task completion.',
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
