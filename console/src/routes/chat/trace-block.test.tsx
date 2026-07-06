import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { TraceChatMessage, TraceStep } from './chat-ui-message';
import { TraceBlock } from './trace-block';

function makeTrace(
  steps: TraceStep[],
  overrides?: Partial<TraceChatMessage>,
): TraceChatMessage {
  return {
    id: 'trace-1',
    role: 'trace',
    content: '',
    sessionId: 'session-a',
    steps,
    done: false,
    startedAt: 1_000,
    ...overrides,
  };
}

describe('TraceBlock', () => {
  it('renders nothing for a trace without steps', () => {
    const { container } = render(<TraceBlock message={makeTrace([])} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows steps expanded while the run is live', () => {
    render(
      <TraceBlock
        message={makeTrace([
          { kind: 'thinking', text: 'Considering the request' },
          { kind: 'draft', text: 'I need to check one thing first.' },
          {
            kind: 'tool',
            toolName: 'exec',
            status: 'running',
            argsPreview: 'npm test',
          },
        ])}
      />,
    );

    const controls = screen.getAllByRole('button');
    expect(controls).toHaveLength(2);
    const firstControl = controls[0];
    const secondControl = controls[1];
    if (!firstControl || !secondControl) throw new Error('expected controls');
    expect(firstControl.getAttribute('aria-expanded')).toBe('true');
    expect(secondControl.getAttribute('aria-expanded')).toBe('true');
    expect(screen.queryByText('exec…')).not.toBeNull();
    expect(screen.queryByText('Considering the request')).not.toBeNull();
    expect(
      screen.queryByText('I need to check one thing first.'),
    ).not.toBeNull();
    expect(screen.queryByText('npm test')).not.toBeNull();
  });

  it('collapses to a summary once the run is done', () => {
    render(
      <TraceBlock
        message={makeTrace(
          [
            { kind: 'thinking', text: 'Considering the request' },
            {
              kind: 'tool',
              toolName: 'exec',
              status: 'done',
              argsPreview: 'npm test',
              resultPreview: 'ok',
              durationMs: 1_200,
            },
            { kind: 'draft', text: 'I need to check one thing first.' },
          ],
          { done: true, finishedAt: 13_000 },
        )}
      />,
    );

    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(screen.queryByText('1 tool call · thinking · 12s')).not.toBeNull();
    expect(
      screen.queryByText('I need to check one thing first.'),
    ).not.toBeNull();
    expect(screen.queryByText('npm test')).toBeNull();
  });

  it('keeps interim drafts outside collapsed trace segments', () => {
    render(
      <TraceBlock
        message={makeTrace(
          [
            { kind: 'thinking', text: 'Considering the request' },
            { kind: 'draft', text: 'I need a location first.' },
            {
              kind: 'tool',
              toolName: 'message',
              status: 'done',
              argsPreview: 'send email',
              durationMs: 250,
            },
            { kind: 'thinking', text: 'Waiting for the tool result' },
          ],
          { done: true, finishedAt: 5_000 },
        )}
      />,
    );

    const controls = screen.getAllByRole('button');
    expect(controls).toHaveLength(2);
    const firstControl = controls[0];
    const secondControl = controls[1];
    if (!firstControl || !secondControl) throw new Error('expected controls');
    expect(firstControl.textContent).toContain('Thought');
    expect(secondControl.textContent).toContain('1 tool call · thinking');
    expect(screen.queryByText('I need a location first.')).not.toBeNull();
    expect(screen.queryByText('Considering the request')).toBeNull();
    expect(screen.queryByText('send email')).toBeNull();

    fireEvent.click(firstControl);
    expect(screen.queryByText('Considering the request')).not.toBeNull();
    expect(screen.queryByText('I need a location first.')).not.toBeNull();
  });

  it('auto-collapses a manually expanded trace when the run finishes', () => {
    const liveSteps: TraceStep[] = [
      {
        kind: 'tool',
        toolName: 'read',
        status: 'running',
        argsPreview: 'apps.ts',
      },
    ];
    const { rerender } = render(<TraceBlock message={makeTrace(liveSteps)} />);

    // Collapse manually mid-run, then re-expand: the user override sticks.
    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByText('apps.ts')).toBeNull();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByText('apps.ts')).not.toBeNull();

    rerender(
      <TraceBlock
        message={makeTrace(
          [
            {
              kind: 'tool',
              toolName: 'read',
              status: 'done',
              argsPreview: 'apps.ts',
              durationMs: 300,
            },
          ],
          { done: true, finishedAt: 2_500 },
        )}
      />,
    );

    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(screen.queryByText('apps.ts')).toBeNull();

    // The collapsed trace can still be reopened on demand.
    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByText('apps.ts')).not.toBeNull();
    expect(screen.queryByText('300ms')).not.toBeNull();
  });

  it('summarizes a thinking-only run', () => {
    render(
      <TraceBlock
        message={makeTrace([{ kind: 'thinking', text: 'Deep thought' }], {
          done: true,
          finishedAt: 32_000,
        })}
      />,
    );
    expect(screen.queryByText('Thought · 31s')).not.toBeNull();
  });
});
