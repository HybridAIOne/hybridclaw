import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const spawnSync = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  spawnSync,
}));

describe('runtime capability hints', () => {
  beforeEach(() => {
    spawnSync.mockReset();
  });

  afterEach(async () => {
    const { resetRuntimeCapabilitiesCache } = await import(
      '../container/src/runtime-capabilities.ts'
    );
    resetRuntimeCapabilitiesCache();
    vi.resetModules();
  });

  test('detects soffice fallback and caches results', async () => {
    spawnSync.mockImplementation((_command: string, args: string[]) => {
      const requested = args[3];
      if (requested === 'soffice') return { status: 1 };
      if (requested === 'libreoffice') return { status: 0 };
      if (requested === 'pdftoppm') return { status: 1 };
      return { status: 1 };
    });

    const { detectRuntimeCapabilities } = await import(
      '../container/src/runtime-capabilities.ts'
    );

    expect(detectRuntimeCapabilities()).toEqual({
      hasSoffice: true,
      hasPdftoppm: false,
    });
    expect(detectRuntimeCapabilities()).toEqual({
      hasSoffice: true,
      hasPdftoppm: false,
    });
    expect(spawnSync).toHaveBeenCalledTimes(3);
  });

  test('merges runtime hints into the existing system message', async () => {
    const { injectRuntimeCapabilitiesMessage } = await import(
      '../container/src/runtime-capabilities.ts'
    );

    const messages = injectRuntimeCapabilitiesMessage(
      [
        { role: 'system', content: 'base instructions' },
        { role: 'user', content: 'Create a PPTX.' },
      ],
      { hasSoffice: false, hasPdftoppm: false },
    );

    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toContain('base instructions');
    expect(messages[0]?.content).toContain(
      'LibreOffice `soffice`: unavailable',
    );
    expect(messages[0]?.content).toContain(
      'Do not attempt PPTX render-and-review when either `soffice` or `pdftoppm` is unavailable.',
    );
    expect(messages[0]?.content).toContain(
      'Skip that QA path silently unless the user explicitly asked for QA',
    );
    expect(messages[0]?.content).toContain(
      'Do not mention missing Office/PDF QA tools in the final reply by default.',
    );
    expect(messages[1]).toEqual({
      role: 'user',
      content: 'Create a PPTX.',
    });
  });

  test('injects a system hint when no system prompt exists yet', async () => {
    const { injectRuntimeCapabilitiesMessage } = await import(
      '../container/src/runtime-capabilities.ts'
    );

    const messages = injectRuntimeCapabilitiesMessage(
      [{ role: 'user', content: 'Create a PPTX.' }],
      { hasSoffice: false, hasPdftoppm: false },
    );

    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toContain(
      'LibreOffice `soffice`: unavailable',
    );
    expect(messages[1]).toEqual({
      role: 'user',
      content: 'Create a PPTX.',
    });
  });

  test('runtime hint marks PPTX render-and-review as required when dependencies exist', async () => {
    const { buildRuntimeCapabilitiesMessage } = await import(
      '../container/src/runtime-capabilities.ts'
    );

    const message = buildRuntimeCapabilitiesMessage({
      hasSoffice: true,
      hasPdftoppm: true,
    });

    expect(message).toContain(
      'For generated `.pptx` decks, run the render-and-review loop before final delivery',
    );
    expect(message).not.toContain(
      'Do not attempt PPTX render-and-review when either `soffice` or `pdftoppm` is unavailable.',
    );
  });
});
