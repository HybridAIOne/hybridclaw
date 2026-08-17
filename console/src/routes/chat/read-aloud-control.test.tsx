import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ReadAloudControl,
  textFromRenderedMarkdown,
} from './read-aloud-control';

const mocks = vi.hoisted(() => ({
  capabilities: { dictation: true, readAloud: true },
  playback: vi.fn(),
  unlockAudio: vi.fn(),
}));

vi.mock('./audio-unlock', () => ({
  unlockAudio: mocks.unlockAudio,
}));

vi.mock('./media-capabilities', () => ({
  useMediaCapabilities: () => mocks.capabilities,
}));

vi.mock('./speech-playback', () => ({
  SpeechPlayback: class {
    readonly implementation: { start: () => void; dispose: () => void };

    constructor(params: unknown) {
      this.implementation = mocks.playback(params);
    }

    start() {
      this.implementation.start();
    }

    dispose() {
      this.implementation.dispose();
    }
  },
}));

describe('ReadAloudControl', () => {
  beforeEach(() => {
    mocks.capabilities = { dictation: true, readAloud: true };
    mocks.playback.mockReset();
    mocks.unlockAudio.mockReset();
    document.documentElement.lang = 'en';
    vi.stubGlobal('Audio', class {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('unlocks and starts generated speech only from an explicit action', () => {
    const start = vi.fn();
    const dispose = vi.fn();
    mocks.playback.mockImplementation(() => ({ start, dispose }));
    render(<ReadAloudControl text="A concise response." token="test-token" />);

    expect(mocks.playback).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole('button', { name: 'Read response aloud' }),
    );

    expect(mocks.unlockAudio).toHaveBeenCalledTimes(1);
    expect(mocks.playback).toHaveBeenCalledWith({
      token: 'test-token',
      text: 'A concise response.',
      onPlaying: expect.any(Function),
      onSettled: expect.any(Function),
    });
    expect(start).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').textContent).toBe('Preparing audio…');

    const callbacks = mocks.playback.mock.calls[0]?.[0] as {
      onPlaying: () => void;
      onSettled: (failed: boolean) => void;
    };
    act(() => callbacks.onPlaying());
    expect(screen.getByRole('status').textContent).toBe(
      'Reading response aloud…',
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Stop reading response' }),
    );
    expect(dispose).toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows a retryable error when generated speech fails', () => {
    mocks.playback.mockImplementation(() => ({
      start: vi.fn(),
      dispose: vi.fn(),
    }));
    render(<ReadAloudControl text="Done." token="test-token" />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Read response aloud' }),
    );
    const callbacks = mocks.playback.mock.calls[0]?.[0] as {
      onSettled: (failed: boolean) => void;
    };
    act(() => callbacks.onSettled(true));

    expect(screen.getByRole('status').textContent).toBe(
      'The response could not be read aloud. Please try again.',
    );
    expect(
      screen
        .getByRole('button', { name: 'Read response aloud' })
        .hasAttribute('disabled'),
    ).toBe(false);
  });

  it('degrades to a disabled control when server speech is unavailable', () => {
    mocks.capabilities = { dictation: true, readAloud: false };
    render(
      <ReadAloudControl text="Text remains readable." token="test-token" />,
    );

    expect(
      screen
        .getByRole('button', {
          name: 'Read aloud requires a HybridAI or OpenAI API key.',
        })
        .hasAttribute('disabled'),
    ).toBe(true);
  });

  it('uses the console language instead of the browser preference', () => {
    const languageDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      'language',
    );
    Object.defineProperty(navigator, 'language', {
      configurable: true,
      value: 'de-DE',
    });

    try {
      render(<ReadAloudControl text="English UI" token="test-token" />);
      expect(
        screen.getByRole('button', { name: 'Read response aloud' }),
      ).toBeTruthy();
    } finally {
      if (languageDescriptor) {
        Object.defineProperty(navigator, 'language', languageDescriptor);
      }
    }
  });

  it('turns rendered markdown into natural speech text', () => {
    expect(
      textFromRenderedMarkdown(
        '<h2>Result</h2><p>Hello <strong>there</strong>.</p>',
      ),
    ).toBe('Result Hello there.');
  });
});
