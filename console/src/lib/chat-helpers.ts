import type { ChatStreamApproval } from '../api/chat-types';
import {
  getActiveSessionId,
  setActiveSessionId,
  subscribeActiveSessionId,
} from './chat-session-store';

export const DEFAULT_AGENT_ID = 'main';

export type ApprovalAction =
  | 'once'
  | 'always'
  | 'session'
  | 'agent'
  | 'all'
  | 'deny';

export function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (v) => v.toString(16).padStart(2, '0')).join('');
}

export function generateWebSessionId(agentId = DEFAULT_AGENT_ID): string {
  const normalized = agentId.trim().toLowerCase();
  return `agent:${encodeURIComponent(normalized)}:channel:web:chat:dm:peer:${randomHex(8)}`;
}

export function readStoredUserId(): string {
  const key = 'hybridclaw_user_id';
  const stored = localStorage.getItem(key);
  if (stored) return stored;
  const id = `web-user-${randomHex(4)}`;
  localStorage.setItem(key, id);
  return id;
}

export function readStoredSessionId(): string {
  return getActiveSessionId();
}

export function storeSessionId(id: string): void {
  setActiveSessionId(id);
}

export function subscribeToStoredSessionId(listener: () => void): () => void {
  return subscribeActiveSessionId(listener);
}

let msgCounter = 0;
export function nextMsgId(): string {
  msgCounter += 1;
  return `local-${msgCounter}-${Date.now()}`;
}

export function copyToClipboard(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  });
}

export function buildApprovalSummary(
  approval: ChatStreamApproval | null,
): string {
  if (!approval) return '';
  if (approval.summary) return approval.summary;
  const lines: string[] = [];
  if (approval.intent) lines.push(`Approval needed for: ${approval.intent}`);
  if (approval.reason) lines.push(`Why: ${approval.reason}`);
  lines.push(`Approval ID: ${approval.approvalId}`);
  return lines.join('\n');
}

const APPROVAL_COMMAND_MAP: Record<string, string> = {
  once: '/approve once',
  always: '/approve always',
  session: '/approve session',
  agent: '/approve agent',
  all: '/approve all',
  deny: '/approve no',
};

export function buildApprovalCommand(
  action: ApprovalAction,
  approvalId: string,
): string | null {
  const base = APPROVAL_COMMAND_MAP[action];
  if (!base) return null;
  const id = approvalId.trim();
  return id ? `${base} ${id}` : base;
}

function buildClipboardUploadFilename(file: File): string {
  const existingName = (file.name ?? '').trim();
  if (existingName) return existingName;
  const extensionMap: Record<string, string> = {
    'application/pdf': '.pdf',
    'image/gif': '.gif',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'text/plain': '.txt',
  };
  const ext = extensionMap[(file.type ?? '').trim().toLowerCase()] ?? '';
  return `clipboard${ext}`;
}

function normalizeUploadFile(file: File): File {
  const filename = buildClipboardUploadFilename(file);
  if (file.name === filename) return file;
  return new File([file], filename, {
    type: file.type || 'application/octet-stream',
    lastModified: Number.isFinite(file.lastModified)
      ? file.lastModified
      : Date.now(),
  });
}

export function extractClipboardFiles(
  clipboardData: DataTransfer | null,
): File[] {
  if (!clipboardData) return [];
  const files: File[] = [];
  for (const file of Array.from(clipboardData.files)) {
    files.push(normalizeUploadFile(file));
  }
  if (files.length > 0) return files;
  const seen = new Set<string>();
  for (const item of Array.from(clipboardData.items)) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (!file) continue;
    const normalized = normalizeUploadFile(file);
    const key = `${normalized.name}:${normalized.size}:${normalized.type}:${normalized.lastModified}`;
    if (seen.has(key)) continue;
    seen.add(key);
    files.push(normalized);
  }
  return files;
}

export function isScrolledNearBottom(
  el: HTMLElement | null,
  threshold = 64,
): boolean {
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}
