import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseQuestions,
  QUESTIONS_MIME_TYPE,
  QuestionsCard,
  questionAnswersMessage,
} from './questions-card';

const fetchArtifactBlobMock =
  vi.fn<(token: string, artifactPath: string) => Promise<Blob>>();

vi.mock('../../api/chat', () => ({
  fetchArtifactBlob: (token: string, artifactPath: string) =>
    fetchArtifactBlobMock(token, artifactPath),
}));

const artifact = {
  path: 'questions/abc.json',
  filename: 'questions.json',
  mimeType: QUESTIONS_MIME_TYPE,
};

function serve(questions: unknown): void {
  // jsdom's Blob has no text(); browsers' does.
  const text = JSON.stringify({ questions });
  fetchArtifactBlobMock.mockResolvedValue({
    text: async () => text,
  } as unknown as Blob);
}

afterEach(() => fetchArtifactBlobMock.mockReset());

describe('parseQuestions', () => {
  it.each([
    ['not JSON', 'nope'],
    ['no questions', '{"questions":[]}'],
    ['one option', '{"questions":[{"question":"Q?","options":["a"]}]}'],
    [
      'a repeated option',
      '{"questions":[{"question":"Q?","options":["a","a"]}]}',
    ],
    [
      'an option past the limit',
      JSON.stringify({
        questions: [{ question: 'Q?', options: ['a', 'b'.repeat(81)] }],
      }),
    ],
  ])('rejects %s', (_name, text) => {
    expect(parseQuestions(text)).toBeNull();
  });
});

describe('questionAnswersMessage', () => {
  it('puts each question beside its answer, and waits for every answer', () => {
    const questions = [
      { question: 'Which account?', options: ['a@example.com', 'Gmail'] },
      { question: 'Attach?', options: ['PDF', 'DOCX'], multiple: true },
    ];
    expect(questionAnswersMessage(questions, [['Gmail'], []])).toBeNull();
    expect(
      questionAnswersMessage(questions, [['Gmail'], ['PDF', 'DOCX']]),
    ).toBe('Which account? Gmail\nAttach? PDF, DOCX');
  });
});

describe('QuestionsCard', () => {
  it('sends one question’s answer on the tap and then holds the pick', async () => {
    serve([
      {
        question: 'Which account should the email go from?',
        options: ['hy@agents.example.com', 'Gmail'],
      },
    ]);
    const onAnswer = vi.fn(async () => true);
    render(
      <QuestionsCard
        artifact={artifact}
        token="t"
        answerable
        onAnswer={onAnswer}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Gmail' }));

    await waitFor(() =>
      expect(onAnswer).toHaveBeenCalledWith(
        'Which account should the email go from? Gmail',
      ),
    );
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Gmail' }) as HTMLButtonElement)
          .disabled,
      ).toBe(true),
    );
    expect(
      screen
        .getByRole('button', { name: 'Gmail' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('only shows what was asked once the chat has moved on', async () => {
    serve([{ question: 'Which?', options: ['a', 'b'] }]);
    const onAnswer = vi.fn(async () => true);
    render(
      <QuestionsCard
        artifact={artifact}
        token="t"
        answerable={false}
        onAnswer={onAnswer}
      />,
    );

    const button = (await screen.findByRole('button', {
      name: 'a',
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onAnswer).not.toHaveBeenCalled();
  });
});
