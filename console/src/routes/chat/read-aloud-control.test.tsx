import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ReadAloudControl,
  textFromRenderedMarkdown,
} from './read-aloud-control';

class FakeUtterance {
  lang = '';
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly text: string) {}
}

function installSpeechSynthesis() {
  const synthesis = {
    cancel: vi.fn(),
    speak: vi.fn(),
  };
  vi.stubGlobal(
    'SpeechSynthesisUtterance',
    FakeUtterance as unknown as typeof SpeechSynthesisUtterance,
  );
  vi.stubGlobal('speechSynthesis', synthesis as unknown as SpeechSynthesis);
  return synthesis;
}

describe('ReadAloudControl', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts and stops speech only from an explicit button action', () => {
    const synthesis = installSpeechSynthesis();
    render(<ReadAloudControl text="A concise response." />);

    expect(synthesis.speak).not.toHaveBeenCalled();
    const start = screen.getByRole('button', { name: 'Read response aloud' });
    fireEvent.click(start);

    expect(synthesis.speak).toHaveBeenCalledTimes(1);
    const utterance = synthesis.speak.mock.calls[0]?.[0] as unknown as {
      lang: string;
      text: string;
    };
    expect(utterance.text).toBe('A concise response.');
    expect(utterance.lang).toBe(navigator.language);
    expect(
      screen
        .getByRole('button', { name: 'Stop reading response' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    expect(screen.getByRole('status').textContent).toBe(
      'Reading response aloud…',
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Stop reading response' }),
    );
    expect(synthesis.cancel).toHaveBeenCalled();
    expect(
      screen
        .getByRole('button', { name: 'Read response aloud' })
        .getAttribute('aria-pressed'),
    ).toBe('false');
  });

  it('finishes cleanly when the browser reports the utterance ended', async () => {
    const synthesis = installSpeechSynthesis();
    render(<ReadAloudControl text="Done." />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Read response aloud' }),
    );
    const utterance = synthesis.speak.mock.calls[0]?.[0] as unknown as {
      onend: () => void;
    };
    await act(async () => utterance.onend());

    expect(
      screen
        .getByRole('button', { name: 'Read response aloud' })
        .getAttribute('aria-pressed'),
    ).toBe('false');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('degrades to a disabled control when speech synthesis is unsupported', () => {
    render(<ReadAloudControl text="Text remains readable." />);

    expect(
      screen
        .getByRole('button', {
          name: 'Your browser does not support read aloud.',
        })
        .hasAttribute('disabled'),
    ).toBe(true);
  });

  it('turns rendered markdown into natural speech text', () => {
    expect(
      textFromRenderedMarkdown(
        '<h2>Result</h2><p>Hello <strong>there</strong>.</p>',
      ),
    ).toBe('Result Hello there.');
  });
});
