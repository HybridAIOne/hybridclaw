import { memo, useEffect, useMemo, useState } from 'react';
import { cx } from '../../lib/cx';
import { renderMarkdown } from '../../lib/markdown';
import css from './chat-page.module.css';
import type { TraceChatMessage, TraceStep } from './chat-ui-message';

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
  steps: TraceStep[],
  includeDuration: boolean,
): string {
  if (!message.done) {
    const last =
      steps
        .slice()
        .reverse()
        .find((step) => step.kind !== 'draft') ?? steps[steps.length - 1];
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
  } else if (steps.some((step) => step.kind === 'draft')) {
    parts.push('Agent activity');
  }
  const elapsed = message.finishedAt
    ? message.finishedAt - message.startedAt
    : 0;
  if (includeDuration && elapsed >= 1000) parts.push(formatDuration(elapsed));
  return parts.join(' · ') || 'Agent activity';
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

function TraceStepRow(props: { step: TraceStep; live: boolean }) {
  const { step, live } = props;
  if (step.kind === 'draft') {
    return <TraceDraftInterim text={step.text} />;
  }

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

function TraceActivityBlock(props: {
  message: TraceChatMessage;
  steps: TraceStep[];
}) {
  const { message, steps } = props;
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
          {summaryLabel(message, steps, true)}
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
 * Collapsible run-activity trace. Draft trace steps are intermediate provider
 * content from tool-call turns: visible while the run is open, then collapsed
 * together with thinking/tool rows once the final answer arrives.
 */
export const TraceBlock = memo(function TraceBlock(props: {
  message: TraceChatMessage;
}) {
  const { message } = props;

  if (message.steps.length === 0) return null;

  return (
    <div className={css.traceSequence}>
      <TraceActivityBlock message={message} steps={message.steps} />
    </div>
  );
});
