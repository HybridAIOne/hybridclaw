import { EventEmitter } from 'node:events';
import type readline from 'node:readline';

import { expect, test, vi } from 'vitest';

import type {
  GatewayAdminAgent,
  GatewayAdminJob,
} from '../src/gateway/gateway-types.js';
import {
  promptTuiJobEdit,
  renderTuiJobEditLines,
  renderTuiJobResultLines,
} from '../src/jobs/tui-edit.js';

const PALETTE = {
  reset: '',
  bold: '',
  muted: '',
  teal: '',
  gold: '',
  green: '',
  red: '',
};

function createVirtualOutput(rows = 18) {
  const screen = [''];
  let row = 0;
  let col = 0;
  let savedRow = 0;
  let savedCol = 0;

  const ensureRow = () => {
    while (screen.length <= row) {
      screen.push('');
    }
  };

  const writeChar = (char: string) => {
    ensureRow();
    const current = screen[row] || '';
    const padded = col > current.length ? current.padEnd(col, ' ') : current;
    screen[row] =
      `${padded.slice(0, col)}${char}${padded.slice(Math.min(padded.length, col + 1))}`;
    col += 1;
  };

  const clearDown = () => {
    ensureRow();
    screen[row] = (screen[row] || '').slice(0, col);
    screen.length = row + 1;
  };

  const scrollIfNeeded = () => {
    while (row >= rows) {
      screen.shift();
      screen.push('');
      row -= 1;
      savedRow = Math.max(0, savedRow - 1);
    }
  };

  const parseCsi = (chunk: string, index: number): number => {
    let cursor = index + 2;
    while (cursor < chunk.length) {
      const code = chunk.charCodeAt(cursor);
      if (code >= 64 && code <= 126) {
        const sequence = chunk.slice(index + 2, cursor);
        const final = chunk[cursor];
        if (final === 'G') {
          const nextCol = Number.parseInt(sequence || '1', 10);
          col = Math.max(0, (Number.isFinite(nextCol) ? nextCol : 1) - 1);
        } else if (final === 'H') {
          const [rowPart, colPart] = sequence.split(';');
          const nextRow = Number.parseInt(rowPart || '1', 10);
          const nextCol = Number.parseInt(colPart || '1', 10);
          row = Math.max(0, (Number.isFinite(nextRow) ? nextRow : 1) - 1);
          col = Math.max(0, (Number.isFinite(nextCol) ? nextCol : 1) - 1);
        } else if (final === 'J') {
          clearDown();
        }
        return cursor + 1;
      }
      cursor += 1;
    }
    return chunk.length;
  };

  const output = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns: 100,
    rows,
    write: (chunk: string) => {
      for (let index = 0; index < chunk.length; ) {
        const char = chunk[index];
        if (char === '\x1b' && chunk[index + 1] === '[') {
          index = parseCsi(chunk, index);
          continue;
        }
        if (char === '\x1b' && chunk[index + 1] === '7') {
          savedRow = row;
          savedCol = col;
          index += 2;
          continue;
        }
        if (char === '\x1b' && chunk[index + 1] === '8') {
          row = savedRow;
          col = savedCol;
          index += 2;
          continue;
        }
        if (char === '\n') {
          row += 1;
          col = 0;
          scrollIfNeeded();
          ensureRow();
          index += 1;
          continue;
        }
        if (char === '\r') {
          col = 0;
          index += 1;
          continue;
        }
        writeChar(char);
        index += 1;
      }
      return true;
    },
    visibleText: () => screen.join('\n'),
  });

  return output as EventEmitter &
    NodeJS.WriteStream & {
      visibleText: () => string;
    };
}

function makeJob(): GatewayAdminJob {
  return {
    id: 7,
    boardId: 'main',
    title: 'Ship job edit flow',
    details: 'Let users edit jobs from the TUI',
    status: 'backlog',
    priority: 'normal',
    assigneeAgentId: null,
    createdByKind: 'user',
    createdById: 'alice',
    sourceSessionId: 'session-7',
    linkedTaskId: null,
    lanePosition: 0,
    createdAt: '2026-03-20T10:00:00.000Z',
    updatedAt: '2026-03-20T10:00:00.000Z',
    completedAt: null,
    archivedAt: null,
  };
}

function makeAgents(): GatewayAdminAgent[] {
  return [
    {
      id: 'main',
      name: 'Main Agent',
      model: 'gpt-5',
      chatbotId: null,
      enableRag: true,
      workspace: null,
      workspacePath: '/tmp/main/workspace',
    },
  ];
}

test('renderTuiJobEditLines shows the form fields and start hint', () => {
  const job = makeJob();
  job.dispatch = {
    phase: 'completed',
    label: 'done',
    summary: 'main completed it',
    attemptCount: 1,
    maxAttempts: 3,
    lastAction: 'dispatch_succeeded',
    lastActionAt: '2026-03-20T10:04:00.000Z',
    sessionId: 'sess_dispatch_1',
  };
  const lines = renderTuiJobEditLines({
    job,
    draft: {
      title: 'Ship job edit flow',
      details: 'Let users edit jobs from the TUI',
      status: 'backlog',
      priority: 'normal',
      assigneeAgentId: 'main',
      sourceSessionId: 'session-7',
      linkedTaskId: 42,
    },
    agents: makeAgents(),
    events: [
      {
        id: 1,
        jobId: 7,
        actorKind: 'system',
        actorId: 'job-dispatcher',
        action: 'dispatch_succeeded',
        payloadJson: '{"attempt":1}',
        createdAt: '2026-03-20T10:04:00.000Z',
      },
    ],
    resultPreview: 'Here are 10 useful feature ideas for hybridclaw.io.',
    hasResultViewer: true,
    cursor: 4,
    width: 90,
    height: 18,
    palette: PALETTE,
  });

  const output = lines.join('\n');
  expect(output).toContain('Job Edit #7');
  expect(output).toContain('Assigned To');
  expect(output).toContain('main — Main Agent');
  expect(output).toContain('Save applies changes.');
  expect(output).toContain('Dispatch');
  expect(output).toContain('main completed it');
  expect(output).toContain('Result');
  expect(output).toContain('Here are 10 useful feature ideas');
  expect(output).toContain('press R to open');
  expect(output).toContain('Activity');
  expect(output).toContain('dispatch succeeded');
});

test('renderTuiJobResultLines renders the dispatch transcript', () => {
  const job = makeJob();
  job.dispatch = {
    phase: 'completed',
    label: 'done',
    summary: 'main completed it',
    attemptCount: 1,
    maxAttempts: 3,
    lastAction: 'dispatch_succeeded',
    lastActionAt: '2026-03-20T10:04:00.000Z',
    sessionId: 'sess_dispatch_1',
  };
  const rendered = renderTuiJobResultLines({
    job,
    messages: [
      {
        id: 1,
        session_id: 'sess_dispatch_1',
        user_id: 'system',
        username: null,
        role: 'assistant',
        content: 'Here are 10 useful feature ideas for hybridclaw.io.',
        created_at: '2026-03-20T10:04:00.000Z',
      },
    ],
    scrollOffset: 0,
    width: 90,
    height: 14,
    palette: PALETTE,
  });

  const output = rendered.lines.join('\n');
  expect(output).toContain('Job Result #7');
  expect(output).toContain('Dispatch session sess_dispatch_1');
  expect(output).toContain('Assistant 2026-03-20T10:04:00.000Z');
  expect(output).toContain(
    'Here are 10 useful feature ideas for hybridclaw.io.',
  );
});

test('promptTuiJobEdit saves changes from the modal form', async () => {
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
  const answers = ['Polish job edit UX'];
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
    question: vi.fn((_prompt: string, callback: (answer: string) => void) => {
      callback(answers.shift() ?? '');
    }),
  } as unknown as readline.Interface;
  const input = Object.assign(new EventEmitter(), {
    isTTY: true,
    on: EventEmitter.prototype.on,
    off: EventEmitter.prototype.off,
  });

  const prompt = promptTuiJobEdit({
    rl,
    job: makeJob(),
    agents: makeAgents(),
    palette: PALETTE,
    output,
    input,
  });

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  input.emit('keypress', '', { name: 'return' });
  await flush();
  input.emit('keypress', '', { name: 's' });
  await flush();
  input.emit('keypress', '', { name: 'down' });
  await flush();
  input.emit('keypress', '', { name: 'down' });
  await flush();
  input.emit('keypress', '', { name: 'down' });
  await flush();
  input.emit('keypress', '', { name: 'down' });
  await flush();
  input.emit('keypress', '', { name: 'right' });
  await flush();
  input.emit('keypress', '', { name: 'down' });
  await flush();
  input.emit('keypress', '', { name: 'down' });
  await flush();
  input.emit('keypress', '', { name: 'down' });
  await flush();
  input.emit('keypress', '', { name: 'return' });

  await expect(prompt).resolves.toEqual({
    cancelled: false,
    status: 'in_progress',
    patch: {
      title: 'Polish job edit UX',
      assigneeAgentId: 'main',
    },
  });
  expect(writes.length).toBeGreaterThan(0);
});

test('promptTuiJobEdit redraws from a fixed origin after inline enter edits', async () => {
  const output = createVirtualOutput();
  const answers = ['Polish job edit UX'];
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
    question: vi.fn((prompt: string, callback: (answer: string) => void) => {
      output.write(prompt);
      output.write('\n');
      callback(answers.shift() ?? '');
    }),
  } as unknown as readline.Interface;
  const input = Object.assign(new EventEmitter(), {
    isTTY: true,
    on: EventEmitter.prototype.on,
    off: EventEmitter.prototype.off,
  });

  void promptTuiJobEdit({
    rl,
    job: makeJob(),
    agents: makeAgents(),
    palette: PALETTE,
    output,
    input,
  });

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  input.emit('keypress', '', { name: 'return' });
  await flush();

  const visible = output.visibleText();
  expect((visible.match(/Job Edit #7/g) || []).length).toBe(1);
  expect(visible).not.toContain('Title [Ship job edit flow]');
  expect(visible).toContain('Polish job edit UX');
});

test('promptTuiJobEdit opens the result viewer and returns to the form', async () => {
  const output = createVirtualOutput(18);
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
    question: vi.fn(),
  } as unknown as readline.Interface;
  const input = Object.assign(new EventEmitter(), {
    isTTY: true,
    on: EventEmitter.prototype.on,
    off: EventEmitter.prototype.off,
  });
  const job = makeJob();
  job.dispatch = {
    phase: 'completed',
    label: 'done',
    summary: 'main completed it',
    attemptCount: 1,
    maxAttempts: 3,
    lastAction: 'dispatch_succeeded',
    lastActionAt: '2026-03-20T10:04:00.000Z',
    sessionId: 'sess_dispatch_1',
  };

  const prompt = promptTuiJobEdit({
    rl,
    job,
    agents: makeAgents(),
    resultPreview: 'Short result preview',
    resultMessages: [
      {
        id: 1,
        session_id: 'sess_dispatch_1',
        user_id: 'system',
        username: null,
        role: 'assistant',
        content: 'Full result body for the job.',
        created_at: '2026-03-20T10:04:00.000Z',
      },
    ],
    palette: PALETTE,
    output,
    input,
  });

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  input.emit('keypress', '', { name: 'r' });
  await flush();
  expect(output.visibleText()).toContain('Job Result #7');
  expect(output.visibleText()).toContain('Full result body for the job.');

  input.emit('keypress', '', { name: 'escape' });
  await flush();
  expect(output.visibleText()).toContain('Job Edit #7');

  input.emit('keypress', '', { name: 'escape' });
  await expect(prompt).resolves.toEqual({
    cancelled: true,
    patch: {},
  });
});

test('promptTuiJobEdit does not duplicate the header while moving through fields', async () => {
  const output = createVirtualOutput(12);
  output.write('prefill\n'.repeat(10));
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
    question: vi.fn(),
  } as unknown as readline.Interface;
  const input = Object.assign(new EventEmitter(), {
    isTTY: true,
    on: EventEmitter.prototype.on,
    off: EventEmitter.prototype.off,
  });

  void promptTuiJobEdit({
    rl,
    job: makeJob(),
    agents: makeAgents(),
    palette: PALETTE,
    output,
    input,
  });

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  input.emit('keypress', '', { name: 'down' });
  await flush();
  input.emit('keypress', '', { name: 'down' });
  await flush();
  input.emit('keypress', '', { name: 'down' });
  await flush();

  const visible = output.visibleText();
  expect((visible.match(/Job Edit #7/g) || []).length).toBe(1);
});

test('promptTuiJobEdit cancels from the modal form', async () => {
  const output = {
    isTTY: true,
    columns: 100,
    rows: 18,
    write: vi.fn(() => true),
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
    question: vi.fn(),
  } as unknown as readline.Interface;
  const input = Object.assign(new EventEmitter(), {
    isTTY: true,
    on: EventEmitter.prototype.on,
    off: EventEmitter.prototype.off,
  });

  const prompt = promptTuiJobEdit({
    rl,
    job: makeJob(),
    agents: makeAgents(),
    palette: PALETTE,
    output,
    input,
  });

  input.emit('keypress', '', { name: 'escape' });

  await expect(prompt).resolves.toEqual({
    cancelled: true,
    patch: {},
  });
});
