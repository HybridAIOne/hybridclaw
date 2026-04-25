import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../src/memory/db.js', () => ({
  getSessionTitle: vi.fn(() => ({ title: null, source: null })),
  setSessionTitle: vi.fn(),
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

const { getSessionTitle, setSessionTitle } = await import(
  '../src/memory/db.js'
);
const { callAuxiliaryModel } = await import('../src/providers/auxiliary.js');
const {
  generateSessionTitle,
  maybeAutoTitleSession,
  normalizeSessionTitle,
  SESSION_TITLE_MAX_CHARS,
} = await import('../src/session/session-title.js');

const mockedAuxiliary = vi.mocked(callAuxiliaryModel);
const mockedGetTitle = vi.mocked(getSessionTitle);
const mockedSetTitle = vi.mocked(setSessionTitle);

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
      enableRag: true,
      model: 'gpt-5',
      userContent: 'Help me ship the deploy.',
      assistantContent: 'Sure, here are the steps.',
    });

    expect(title).toBe('Deploy Plan');
    expect(mockedAuxiliary).toHaveBeenCalledWith(
      expect.objectContaining({ task: 'session_title' }),
    );
  });

  test('returns null when the auxiliary model throws', async () => {
    mockedAuxiliary.mockRejectedValueOnce(new Error('boom'));

    const title = await generateSessionTitle({
      sessionId: 's1',
      agentId: 'main',
      chatbotId: null,
      enableRag: true,
      model: 'gpt-5',
      userContent: 'Help me ship the deploy.',
      assistantContent: 'Sure, here are the steps.',
    });

    expect(title).toBeNull();
  });

  test('skips the model call when user content is empty', async () => {
    mockedAuxiliary.mockClear();

    const title = await generateSessionTitle({
      sessionId: 's1',
      agentId: 'main',
      chatbotId: null,
      enableRag: true,
      model: 'gpt-5',
      userContent: '   ',
      assistantContent: 'Sure.',
    });

    expect(title).toBeNull();
    expect(mockedAuxiliary).not.toHaveBeenCalled();
  });
});

describe('maybeAutoTitleSession', () => {
  beforeEach(() => {
    mockedAuxiliary.mockReset();
    mockedSetTitle.mockReset();
    mockedGetTitle.mockReset();
    mockedGetTitle.mockReturnValue({ title: null, source: null });
  });

  test('skips when userMessageCount > 1', async () => {
    maybeAutoTitleSession({
      sessionId: 's1',
      agentId: 'main',
      chatbotId: null,
      enableRag: true,
      model: 'gpt-5',
      userContent: 'second turn',
      assistantContent: 'reply',
      userMessageCount: 2,
    });
    await flushMicrotasks();

    expect(mockedAuxiliary).not.toHaveBeenCalled();
    expect(mockedSetTitle).not.toHaveBeenCalled();
  });

  test('skips when a title already exists', async () => {
    mockedGetTitle.mockReturnValue({ title: 'Already Set', source: 'user' });

    maybeAutoTitleSession({
      sessionId: 's1',
      agentId: 'main',
      chatbotId: null,
      enableRag: true,
      model: 'gpt-5',
      userContent: 'first',
      assistantContent: 'reply',
      userMessageCount: 1,
    });
    await flushMicrotasks();

    expect(mockedAuxiliary).not.toHaveBeenCalled();
    expect(mockedSetTitle).not.toHaveBeenCalled();
  });

  test('persists the generated title on the first turn', async () => {
    mockedAuxiliary.mockResolvedValue({
      provider: 'hybridai',
      model: 'cheap',
      content: 'Deploy Plan',
    });

    maybeAutoTitleSession({
      sessionId: 's1',
      agentId: 'main',
      chatbotId: null,
      enableRag: true,
      model: 'gpt-5',
      userContent: 'help me deploy',
      assistantContent: 'sure',
      userMessageCount: 1,
    });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(mockedAuxiliary).toHaveBeenCalledTimes(1);
    expect(mockedSetTitle).toHaveBeenCalledWith('s1', 'Deploy Plan', 'auto');
  });

  test('does not call setSessionTitle when generation returns null', async () => {
    mockedAuxiliary.mockResolvedValue({
      provider: 'hybridai',
      model: 'cheap',
      content: 'Untitled',
    });

    maybeAutoTitleSession({
      sessionId: 's1',
      agentId: 'main',
      chatbotId: null,
      enableRag: true,
      model: 'gpt-5',
      userContent: 'help me deploy',
      assistantContent: 'sure',
      userMessageCount: 1,
    });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(mockedSetTitle).not.toHaveBeenCalled();
  });
});
