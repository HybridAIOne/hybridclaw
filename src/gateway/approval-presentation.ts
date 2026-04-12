export type ApprovalPresentationMode = 'text' | 'buttons' | 'both';

export interface ApprovalPresentation {
  mode: ApprovalPresentationMode;
  showText: boolean;
  showButtons: boolean;
  showReplyText: boolean;
}

interface ApprovalPromptSource {
  prompt?: string | null;
  summary?: string | null;
}

export function createApprovalPresentation(
  mode: ApprovalPresentationMode,
): ApprovalPresentation {
  if (mode === 'buttons') {
    return {
      mode,
      showText: true,
      showButtons: true,
      showReplyText: false,
    };
  }
  if (mode === 'both') {
    return {
      mode,
      showText: true,
      showButtons: true,
      showReplyText: true,
    };
  }
  return {
    mode: 'text',
    showText: true,
    showButtons: false,
    showReplyText: true,
  };
}

function stripApprovalReplyLines(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => !/^Reply\b/i.test(line.trim()))
    .join('\n')
    .trim();
}

export function getApprovalPromptText(
  approval: ApprovalPromptSource,
  fallback = 'Approval required.',
): string {
  const prompt = String(approval.prompt || '').trim();
  if (prompt) return prompt;

  const normalizedFallback = String(fallback).trim();
  if (normalizedFallback) return normalizedFallback;

  const summary = String(approval.summary || '').trim();
  if (summary) return summary;
  return 'Approval required.';
}

export function getApprovalVisibleText(
  approval: ApprovalPromptSource,
  presentation: ApprovalPresentation,
  fallback = 'Approval required.',
): string {
  if (!presentation.showText) return '';
  const promptText = getApprovalPromptText(approval, fallback);
  if (presentation.showReplyText) {
    return promptText;
  }
  const stripped = stripApprovalReplyLines(promptText);
  return stripped || promptText;
}
