import { useMemo } from 'react';
import type { ChatStreamApproval } from '../../api/chat-types';
import { Button } from '../../components/button';
import type { ApprovalAction } from '../../lib/chat-helpers';
import css from './chat-page.module.css';

const TRUST_APPROVAL_BUTTONS: ReadonlyArray<{
  label: string;
  action: ApprovalAction;
  isAvailable: (approval: ChatStreamApproval) => boolean;
}> = [
  {
    label: 'Trust session',
    action: 'session',
    isAvailable: (approval) => approval.allowSession === true,
  },
  {
    label: 'Trust agent',
    action: 'agent',
    isAvailable: (approval) => approval.allowAgent === true,
  },
  {
    label: 'Always allow',
    action: 'all',
    isAvailable: (approval) => approval.allowAll === true,
  },
];

interface ApprovalDetailRow {
  label: string;
  value: string;
}

interface ParsedPromptLines {
  introLine?: string;
  rows: ApprovalDetailRow[];
}

const PROMPT_FIELD_RE = /^([^:\n]{2,44}):\s+(.+)$/;
const HTTP_METHOD_RE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+/i;

function prettifyApprovalTier(
  tier: ChatStreamApproval['approvalTier'] | undefined,
): string | null {
  if (tier === 'yellow') return 'Amber';
  if (tier === 'red') return 'Red';
  return null;
}

function isPromptInstructionLine(line: string): boolean {
  return (
    /^reply\b/i.test(line) ||
    /^approval expires\b/i.test(line) ||
    /^approval id\b/i.test(line)
  );
}

function normalizePromptLabel(label: string): string {
  const trimmed = label.trim();
  if (/^proposed action$/i.test(trimmed)) return 'Request';
  if (/^why$/i.test(trimmed)) return 'Reason';
  return trimmed;
}

function parsePromptLines(prompt: string): ParsedPromptLines {
  const rows: ApprovalDetailRow[] = [];
  let introLine: string | undefined;

  const promptLines = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of promptLines) {
    if (isPromptInstructionLine(line)) continue;
    if (/^classifier reasoning$/i.test(line)) continue;
    if (/^if you skip this/i.test(line)) continue;

    const match = line.match(PROMPT_FIELD_RE);
    if (match) {
      const label = normalizePromptLabel(match[1] ?? '');
      if (!/^classifier reasoning$/i.test(label)) {
        rows.push({ label, value: match[2] ?? '' });
      }
      continue;
    }

    introLine ??= line;
  }

  return { introLine, rows };
}

function buildApprovalRows(approval: ChatStreamApproval): ApprovalDetailRow[] {
  const rows: ApprovalDetailRow[] = [];
  const seen = new Set<string>();
  const addRow = (label: string, value: unknown): void => {
    const normalizedLabel = label.trim();
    const normalizedValue = String(value ?? '').trim();
    if (!normalizedLabel || !normalizedValue) return;
    const key = `${normalizedLabel.toLowerCase()}:${normalizedValue}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ label: normalizedLabel, value: normalizedValue });
  };

  if (approval.intent) addRow('Action', approval.intent);
  if (approval.commandPreview) {
    addRow(
      HTTP_METHOD_RE.test(approval.commandPreview) ? 'Request' : 'Preview',
      approval.commandPreview,
    );
  }
  if (approval.toolName) addRow('Tool', approval.toolName);

  for (const row of parsePromptLines(approval.prompt).rows) {
    addRow(row.label, row.value);
  }

  addRow('Approval ID', approval.approvalId);
  if (approval.expiresAt && Number.isFinite(approval.expiresAt)) {
    const expiresAt = new Date(approval.expiresAt);
    if (!Number.isNaN(expiresAt.getTime())) {
      addRow('Expires', expiresAt.toLocaleTimeString());
    }
  }

  return rows;
}

function buildApprovalIntro(approval: ChatStreamApproval): string {
  const { introLine } = parsePromptLines(approval.prompt);
  if (introLine) return introLine;
  if (approval.summary) return approval.summary.split(/\r?\n/)[0] ?? '';
  if (approval.intent) return `Confirmation required for ${approval.intent}.`;
  return 'Confirmation required before this action can continue.';
}

export function ApprovalCard(props: {
  approval: ChatStreamApproval;
  busy: boolean;
  onAction: (action: ApprovalAction, approvalId: string) => void;
}) {
  const { approval } = props;
  const rows = useMemo(() => buildApprovalRows(approval), [approval]);
  const intro = useMemo(() => buildApprovalIntro(approval), [approval]);
  const availableTrustButtons = TRUST_APPROVAL_BUTTONS.filter((btn) =>
    btn.isAvailable(approval),
  );
  const tierLabel = prettifyApprovalTier(approval.approvalTier);

  const handleAction = (action: ApprovalAction) => {
    props.onAction(action, approval.approvalId);
  };

  return (
    <div className={css.approvalCard}>
      <div className={css.approvalHeader}>
        {tierLabel ? (
          <span className={css.approvalTier}>{tierLabel}</span>
        ) : null}
        <span className={css.approvalTitle}>Confirmation required</span>
      </div>
      <p className={css.approvalIntro}>{intro}</p>
      {rows.length > 0 ? (
        <dl className={css.approvalDetails}>
          {rows.map((row) => (
            <div
              className={css.approvalDetailRow}
              key={`${row.label}:${row.value}`}
            >
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <div className={css.approvalPrimaryActions}>
        <Button
          size="sm"
          disabled={props.busy}
          onClick={() => handleAction('once')}
        >
          Allow once
        </Button>
        <Button
          variant="danger"
          size="sm"
          disabled={props.busy}
          onClick={() => handleAction('deny')}
        >
          Cancel
        </Button>
      </div>
      {availableTrustButtons.length > 0 ? (
        <div className={css.approvalTrustActions}>
          {availableTrustButtons.map((btn) => (
            <Button
              key={btn.action}
              variant="outline"
              size="sm"
              className={css.approvalAllow}
              disabled={props.busy}
              onClick={() => handleAction(btn.action)}
            >
              {btn.label}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
