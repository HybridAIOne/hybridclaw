import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../src/memory/db.js', () => ({
  setSessionTitle: vi.fn(),
}));

vi.mock('../src/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../src/observability/otel.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/observability/otel.js')>();
  return {
    ...actual,
    withSpan: <T>(_name: string, _attrs: unknown, fn: () => Promise<T>) => fn(),
  };
});

vi.mock('../src/providers/auxiliary.js', () => ({
  callAuxiliaryModel: vi.fn(),
}));

vi.mock('../src/providers/task-routing.js', () => ({
  isAuxiliaryTaskDisabled: vi.fn(() => false),
}));

const { setSessionTitle } = await import('../src/memory/db.js');
const { logger } = await import('../src/logger.js');
const { callAuxiliaryModel } = await import('../src/providers/auxiliary.js');
const { isAuxiliaryTaskDisabled } = await import(
  '../src/providers/task-routing.js'
);
const {
  generateSessionTitle,
  normalizeSessionTitle,
  SESSION_TITLE_MAX_CHARS,
  startSessionTitle,
} = await import('../src/session/session-title.js');

const mockedAuxiliary = vi.mocked(callAuxiliaryModel);
const mockedIsAuxiliaryTaskDisabled = vi.mocked(isAuxiliaryTaskDisabled);
const mockedSetTitle = vi.mocked(setSessionTitle);
const mockedLogger = vi.mocked(logger);

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('normalizeSessionTitle', () => {
  test('strips wrapping quotes and Title: prefix', () => {
    expect(normalizeSessionTitle('"Deploy Plan"')).toBe('Deploy Plan');
    expect(normalizeSessionTitle('Title: Deploy Plan')).toBe('Deploy Plan');
    expect(normalizeSessionTitle('  “Deploy Plan”  ')).toBe('Deploy Plan');
  });

  test('removes trailing punctuation and collapses whitespace', () => {
    expect(normalizeSessionTitle('Deploy   Plan.')).toBe('Deploy Plan');
    expect(normalizeSessionTitle('Deploy Plan!\n')).toBe('Deploy Plan');
  });

  test('strips <think> blocks emitted by reasoning models', () => {
    expect(normalizeSessionTitle('<think>plan</think>Deploy Plan')).toBe(
      'Deploy Plan',
    );
  });

  test('caps at SESSION_TITLE_MAX_CHARS', () => {
    const long = 'A'.repeat(SESSION_TITLE_MAX_CHARS + 20);
    const result = normalizeSessionTitle(long);
    expect(result?.length).toBe(SESSION_TITLE_MAX_CHARS);
  });

  test('rejects empty, single-char, or untitled outputs', () => {
    expect(normalizeSessionTitle('')).toBeNull();
    expect(normalizeSessionTitle('   ')).toBeNull();
    expect(normalizeSessionTitle('A')).toBeNull();
    expect(normalizeSessionTitle('Untitled')).toBeNull();
    expect(normalizeSessionTitle('"untitled"')).toBeNull();
  });
});

describe('generateSessionTitle', () => {
  test('returns the cleaned title from the auxiliary model', async () => {
    mockedAuxiliary.mockResolvedValueOnce({
      provider: 'hybridai',
      model: 'cheap',
      content: '"Deploy Plan."',
    });

    const title = await generateSessionTitle({
      sessionId: 's1',
      agentId: 'main',
      chatbotId: null,
      model: 'gpt-5',
      userContent: 'Help me ship the deploy.',
    });

    expect(title).toBe('Deploy Plan');
    expect(mockedAuxiliary).toHaveBeenCalledWith(
      expect.objectContaining({
        task: 'session_title',
        fallbackEnableRag: false,
      }),
    );
  });

  test('propagates auxiliary model errors', async () => {
    mockedAuxiliary.mockRejectedValueOnce(new Error('boom'));

    await expect(
      generateSessionTitle({
        sessionId: 's1',
        agentId: 'main',
        chatbotId: null,
        model: 'gpt-5',
        userContent: 'Help me ship the deploy.',
      }),
    ).rejects.toThrow('boom');
  });

  test('truncates title input before calling the auxiliary model', async () => {
    mockedAuxiliary.mockResolvedValueOnce({
      provider: 'hybridai',
      model: 'cheap',
      content: 'Deploy Plan',
    });

    await generateSessionTitle({
      sessionId: 's1',
      agentId: 'main',
      chatbotId: null,
      model: 'gpt-5',
      userContent: ` ${'u'.repeat(600)} `,
    });

    expect(mockedAuxiliary).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: `User: ${'u'.repeat(500)}`,
          }),
        ]),
      }),
    );
  });

  test('skips the model call when user content is empty', async () => {
    mockedAuxiliary.mockClear();

    const title = await generateSessionTitle({
      sessionId: 's1',
      agentId: 'main',
      chatbotId: null,
      model: 'gpt-5',
      userContent: '   ',
    });

    expect(title).toBeNull();
    expect(mockedAuxiliary).not.toHaveBeenCalled();
  });

  test('skips the model call when session title generation is disabled', async () => {
    mockedIsAuxiliaryTaskDisabled.mockReturnValueOnce(true);

    const title = await generateSessionTitle({
      sessionId: 's1',
      agentId: 'main',
      chatbotId: null,
      model: 'gpt-5',
      userContent: 'Help me ship the deploy.',
    });

    expect(title).toBeNull();
    expect(mockedAuxiliary).not.toHaveBeenCalled();
  });
});

describe('startSessionTitle', () => {
  const firstTurn = {
    sessionId: 's1',
    agentId: 'main',
    chatbotId: null,
    model: 'gpt-5',
    userContent: 'help me deploy',
    isFirstTurn: true,
  };

  beforeEach(() => {
    mockedAuxiliary.mockReset();
    mockedIsAuxiliaryTaskDisabled.mockReset();
    mockedIsAuxiliaryTaskDisabled.mockReturnValue(false);
    mockedSetTitle.mockReset();
    mockedLogger.debug.mockReset();
    mockedLogger.warn.mockReset();
  });

  test.each([
    ['a later turn', { isFirstTurn: false }],
    ['an empty message', { userContent: '   ' }],
  ])('starts nothing for %s', (_label, overrides) => {
    expect(startSessionTitle({ ...firstTurn, ...overrides })).toBeNull();
    expect(mockedAuxiliary).not.toHaveBeenCalled();
  });

  test('starts generating at once and offers the title only once it is ready', async () => {
    let finish: (content: string) => void = () => {};
    mockedAuxiliary.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = (content) =>
          resolve({ provider: 'hybridai', model: 'cheap', content });
      }),
    );

    const request = startSessionTitle(firstTurn);

    expect(mockedAuxiliary).toHaveBeenCalledTimes(1);
    expect(request?.readyTitle()).toBeUndefined();
    finish('Deploy Plan');
    await flushMicrotasks();
    expect(request?.readyTitle()).toBe('Deploy Plan');
  });

  test('stores a title that is still pending once it is ready', async () => {
    let finish: (content: string) => void = () => {};
    mockedAuxiliary.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = (content) =>
          resolve({ provider: 'hybridai', model: 'cheap', content });
      }),
    );

    startSessionTitle(firstTurn)?.persist();
    await flushMicrotasks();
    expect(mockedSetTitle).not.toHaveBeenCalled();

    finish('Deploy Plan');
    await flushMicrotasks();
    expect(mockedSetTitle).toHaveBeenCalledWith('s1', 'Deploy Plan');
  });

  test('stores nothing unless the turn persists it', async () => {
    mockedAuxiliary.mockResolvedValueOnce({
      provider: 'hybridai',
      model: 'cheap',
      content: 'Deploy Plan',
    });

    const request = startSessionTitle(firstTurn);
    await flushMicrotasks();

    expect(request?.readyTitle()).toBe('Deploy Plan');
    expect(mockedSetTitle).not.toHaveBeenCalled();
  });

  test('stores nothing when generation returns no usable title', async () => {
    mockedAuxiliary.mockResolvedValueOnce({
      provider: 'hybridai',
      model: 'cheap',
      content: 'Untitled',
    });

    const request = startSessionTitle(firstTurn);
    request?.persist();
    await flushMicrotasks();

    expect(request?.readyTitle()).toBeUndefined();
    expect(mockedSetTitle).not.toHaveBeenCalled();
  });

  test.each([
    ['other errors as warnings', new Error('boom'), 'warn'],
    [
      'transient provider timeouts at debug level',
      new TypeError('fetch failed', {
        cause: new Error('Headers Timeout Error'),
      }),
      'debug',
    ],
  ] as const)('logs %s and leaves the title unset', async (_label, error, level) => {
    mockedAuxiliary.mockRejectedValueOnce(error);

    const request = startSessionTitle(firstTurn);
    request?.persist();
    await flushMicrotasks();

    expect(request?.readyTitle()).toBeUndefined();
    expect(mockedSetTitle).not.toHaveBeenCalled();
    expect(mockedLogger[level]).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's1', err: error }),
      'Session title auto-update failed',
    );
    const other = level === 'warn' ? 'debug' : 'warn';
    expect(mockedLogger[other]).not.toHaveBeenCalled();
  });
});
