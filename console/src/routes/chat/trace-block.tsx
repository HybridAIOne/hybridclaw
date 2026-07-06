import { memo, useEffect, useMemo, useState } from 'react';
import { cx } from '../../lib/cx';
import { renderMarkdown } from '../../lib/markdown';
import css from './chat-page.module.css';
import type { TraceChatMessage, TraceStep } from './chat-ui-message';

type TraceActivityStep = Exclude<TraceStep, { kind: 'draft' }>;

type TracePart =
  | { kind: 'activity'; steps: TraceActivityStep[] }
  | { kind: 'draft'; text: string };

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function summaryLabel(
  message: TraceChatMessage,
  steps: TraceActivityStep[],
  includeDuration: boolean,
): string {
  if (!message.done) {
    const last = steps[steps.length - 1];
    if (last?.kind === 'tool' && last.status === 'running') {
      return `${last.toolName}…`;
    }
    if (last?.kind === 'thinking') return 'Thinking…';
    return 'Working…';
  }
  const toolCount = steps.filter((step) => step.kind === 'tool').length;
  const thought = steps.some((step) => step.kind === 'thinking');
  const parts: string[] = [];
  if (toolCount > 0) {
    parts.push(`${toolCount} tool call${toolCount === 1 ? '' : 's'}`);
    if (thought) parts.push('thinking');
  } else if (thought) {
    parts.push('Thought');
  }
  const elapsed = message.finishedAt
    ? message.finishedAt - message.startedAt
    : 0;
  if (includeDuration && elapsed >= 1000) parts.push(formatDuration(elapsed));
  return parts.join(' · ') || 'Agent activity';
}

function splitTraceParts(steps: TraceStep[]): TracePart[] {
  const parts: TracePart[] = [];
  let activitySteps: TraceActivityStep[] = [];

  const flushActivity = () => {
    if (activitySteps.length === 0) return;
    parts.push({ kind: 'activity', steps: activitySteps });
    activitySteps = [];
  };

  for (const step of steps) {
    if (step.kind === 'draft') {
      flushActivity();
      if (step.text.trim()) {
        parts.push({ kind: 'draft', text: step.text });
      }
      continue;
    }
    activitySteps.push(step);
  }

  flushActivity();
  return parts;
}

function TraceStepRow(props: { step: TraceActivityStep; live: boolean }) {
  const { step, live } = props;
  if (step.kind === 'thinking') {
    return (
      <div className={css.traceStep}>
        <span className={css.traceStepMarker} aria-hidden="true">
          <span className={css.traceDot} />
        </span>
        <div className={css.traceThinkingText}>{step.text}</div>
      </div>
    );
  }

  const running = live && step.status === 'running';
  return (
    <div className={css.traceStep}>
      <span className={css.traceStepMarker} aria-hidden="true">
        <span className={cx(css.traceDot, running && css.traceDotRunning)} />
      </span>
      <div className={css.traceStepBody}>
        <div className={css.traceToolLine}>
          <span className={css.traceToolName}>{step.toolName}</span>
          {step.argsPreview ? (
            <span className={css.traceToolPreview} title={step.argsPreview}>
              {step.argsPreview}
            </span>
          ) : null}
          {typeof step.durationMs === 'number' ? (
            <span className={css.traceToolDuration}>
              {formatDuration(step.durationMs)}
            </span>
          ) : null}
        </div>
        {step.resultPreview ? (
          <div className={css.traceToolResult} title={step.resultPreview}>
            {step.resultPreview}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function TraceDraftInterim(props: { text: string }) {
  const renderedHtml = useMemo(
    () => renderMarkdown(props.text, { highlight: false }),
    [props.text],
  );

  return (
    <div className={css.traceDraftInterim}>
      <div
        className={css.markdownContent}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: markdown output is rendered by marked and sanitized through sanitize-html
        dangerouslySetInnerHTML={{ __html: renderedHtml }}
      />
    </div>
  );
}

function TraceActivityBlock(props: {
  message: TraceChatMessage;
  steps: TraceActivityStep[];
  includeDuration: boolean;
}) {
  const { message, steps, includeDuration } = props;
  const [expandedOverride, setExpandedOverride] = useState<boolean | null>(
    null,
  );

  // The final output collapses the trace even if the user expanded it
  // mid-run — the answer should stand alone; the trace stays a click away.
  useEffect(() => {
    if (message.done) setExpandedOverride(null);
  }, [message.done]);

  if (steps.length === 0) return null;

  const expanded = expandedOverride ?? !message.done;

  return (
    <div className={css.traceBlock}>
      <button
        type="button"
        className={css.traceHeader}
        aria-expanded={expanded}
        aria-label={
          expanded ? 'Collapse agent activity' : 'Expand agent activity'
        }
        onClick={() => setExpandedOverride(!expanded)}
      >
        <span
          className={cx(css.traceChevron, expanded && css.traceChevronOpen)}
          aria-hidden="true"
        >
          ›
        </span>
        <span
          className={cx(
            css.traceSummary,
            !message.done && css.traceSummaryLive,
          )}
        >
          {summaryLabel(message, steps, includeDuration)}
        </span>
      </button>
      {expanded ? (
        <div className={css.traceSteps}>
          {steps.map((step, index) => (
            <TraceStepRow
              // Steps are append-only within a segment, so the index is stable.
              // biome-ignore lint/suspicious/noArrayIndexKey: append-only list
              key={index}
              step={step}
              live={!message.done}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Collapsible run-activity trace (thinking + tool calls) plus visible interim
 * assistant drafts. Drafts stay outside the collapsible grey trace so they
 * remain readable after the run finishes.
 */
export const TraceBlock = memo(function TraceBlock(props: {
  message: TraceChatMessage;
}) {
  const { message } = props;

  if (message.steps.length === 0) return null;

  const parts = splitTraceParts(message.steps);
  if (parts.length === 0) return null;
  const activityPartCount = parts.filter(
    (part) => part.kind === 'activity',
  ).length;

  return (
    <div className={css.traceSequence}>
      {parts.map((part, index) =>
        part.kind === 'draft' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: trace parts are append-only
          <TraceDraftInterim key={index} text={part.text} />
        ) : (
          <TraceActivityBlock
            // biome-ignore lint/suspicious/noArrayIndexKey: trace parts are append-only
            key={index}
            message={message}
            steps={part.steps}
            includeDuration={activityPartCount === 1}
          />
        ),
      )}
    </div>
  );
});
