import { EventEmitter } from 'node:events';
import type readline from 'node:readline';

import { expect, test, vi } from 'vitest';

import type { GatewayAdminJobsResponse } from '../src/gateway/gateway-types.js';
import {
  promptTuiJobsBoard,
  renderTuiJobsBoardLines,
} from '../src/jobs/tui-board.js';

const PALETTE = {
  reset: '',
  bold: '',
  muted: '',
  teal: '',
  gold: '',
  green: '',
  red: '',
  selected: '',
  backlog: '',
  ready: '',
  progress: '',
  blocked: '',
  done: '',
  backlogFill: '',
  readyFill: '',
  progressFill: '',
  blockedFill: '',
  doneFill: '',
};

function makeResponse(): GatewayAdminJobsResponse {
  return {
    boardId: 'main',
    columns: [
      { id: 'backlog', label: 'Backlog', count: 2 },
      { id: 'ready', label: 'Ready', count: 1 },
      { id: 'in_progress', label: 'In Progress', count: 1 },
      { id: 'blocked', label: 'Blocked', count: 0 },
      { id: 'done', label: 'Done', count: 0 },
    ],
    jobs: [
      {
        id: 11,
        boardId: 'main',
        title: 'Polish onboarding copy',
        details: 'Review the first-run copy',
        status: 'backlog',
        priority: 'high',
        assigneeAgentId: null,
        createdByKind: 'user',
        createdById: 'alice',
        sourceSessionId: 'session-1',
        linkedTaskId: null,
        lanePosition: 0,
        createdAt: '2026-03-20T10:00:00.000Z',
        updatedAt: '2026-03-20T10:00:00.000Z',
        completedAt: null,
        archivedAt: null,
      },
      {
        id: 12,
        boardId: 'main',
        title: 'Tighten approval copy',
        details: 'Clarify approval options in the TUI',
        status: 'backlog',
        priority: 'normal',
        assigneeAgentId: 'main',
        createdByKind: 'agent',
        createdById: 'main',
        sourceSessionId: 'session-2',
        linkedTaskId: null,
        lanePosition: 1,
        createdAt: '2026-03-20T10:02:00.000Z',
        updatedAt: '2026-03-20T10:02:00.000Z',
        completedAt: null,
        archivedAt: null,
      },
      {
        id: 21,
        boardId: 'main',
        title: 'Implement terminal board',
        details: 'Add a keyboard-driven jobs board',
        status: 'ready',
        priority: 'urgent',
        assigneeAgentId: 'main',
        createdByKind: 'user',
        createdById: 'alice',
        sourceSessionId: 'session-3',
        linkedTaskId: null,
        lanePosition: 0,
        createdAt: '2026-03-20T10:03:00.000Z',
        updatedAt: '2026-03-20T10:03:00.000Z',
        completedAt: null,
        archivedAt: null,
      },
      {
        id: 31,
        boardId: 'main',
        title: 'Ship tests',
        details: 'Cover the jobs board modal',
        status: 'in_progress',
        priority: 'high',
        assigneeAgentId: 'main',
        createdByKind: 'agent',
        createdById: 'main',
        sourceSessionId: 'session-4',
        linkedTaskId: null,
        lanePosition: 0,
        createdAt: '2026-03-20T10:04:00.000Z',
        updatedAt: '2026-03-20T10:04:00.000Z',
        completedAt: null,
        archivedAt: null,
      },
    ],
  };
}

test('renderTuiJobsBoardLines renders lanes and selected job details', () => {
  const rendered = renderTuiJobsBoardLines({
    response: makeResponse(),
    activeColumnIndex: 0,
    cursors: [1, 0, 0, 0, 0],
    scrollOffsets: [0, 0, 0, 0, 0],
    width: 80,
    height: 16,
    palette: PALETTE,
  });

  const output = rendered.lines.join('\n');
  expect(output).toContain('Jobs Board');
  expect(output).toContain('◉ Backlog');
  expect(output).toContain('○ Ready');
  expect(output).toContain('╭');
  expect(output).toContain('#12 Tighten approval copy');
  expect(output).toContain('Clarify approval options in the TUI');
});

test('promptTuiJobsBoard opens the focused job after arrow navigation', async () => {
  const writes: string[] = [];
  const output = {
    isTTY: true,
    columns: 100,
    rows: 18,
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as NodeJS.WriteStream;
  const rl = {
    line: '',
    cursor: 0,
    listeners: vi.fn((event: string) => {
      if (event === 'line' || event === 'SIGINT') return [];
      return [];
    }),
    on: vi.fn(),
    off: vi.fn(),
    prompt: vi.fn(),
  } as unknown as readline.Interface;
  const input = Object.assign(new EventEmitter(), {
    isTTY: true,
    on: EventEmitter.prototype.on,
    off: EventEmitter.prototype.off,
  });

  const prompt = promptTuiJobsBoard({
    rl,
    response: makeResponse(),
    palette: PALETTE,
    output,
    input: input as unknown as NodeJS.ReadStream,
  });

  input.emit('keypress', '', { name: 'right' });
  input.emit('keypress', '', { name: 'return' });

  await expect(prompt).resolves.toEqual({
    cancelled: false,
    openedJobId: 21,
  });
  expect(writes.length).toBeGreaterThan(0);
});
