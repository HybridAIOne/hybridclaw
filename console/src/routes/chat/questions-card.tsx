/**
 * The web chat's card for an `ask_questions` file: each question with its
 * choices as buttons. The answers go back as the user's next message, one
 * line per question ("<question> <answer>"), the way the Hy app sends them,
 * so the agent reads both alike and a bare "Yes" never passes for an
 * approval.
 *
 * Only the latest reply's card can be answered; once the chat has moved on
 * it only shows what was asked. NOT a free-text form: the composer is for an
 * answer of the user's own.
 */
import { useEffect, useState } from 'react';
import { fetchArtifactBlob } from '../../api/chat';
import type { ChatArtifact } from '../../api/chat-types';
import { Button } from '../../components/button';
import own from './questions-card.module.css';
import css from './review-card.module.css';

export const QUESTIONS_MIME_TYPE = 'application/vnd.hybridai.questions+json';

export interface ChatQuestion {
  question: string;
  options: string[];
  multiple?: boolean;
}

export function isQuestionsArtifact(artifact: ChatArtifact): boolean {
  return artifact.mimeType?.toLowerCase() === QUESTIONS_MIME_TYPE;
}

// The tool's limits (`container/src/tools/questions.ts`); a file outside
// them is shown as a plain attachment instead.
function readQuestion(value: unknown): ChatQuestion | null {
  if (!value || typeof value !== 'object') return null;
  const { question, options, multiple } = value as Record<string, unknown>;
  if (typeof question !== 'string' || !Array.isArray(options)) return null;
  const text = question.trim();
  const choices = options.map((option) =>
    typeof option === 'string' ? option.trim() : '',
  );
  if (
    !text ||
    text.length > 200 ||
    choices.length < 2 ||
    choices.length > 5 ||
    choices.some((choice) => !choice || choice.length > 80) ||
    new Set(choices).size !== choices.length
  ) {
    return null;
  }
  return {
    question: text,
    options: choices,
    ...(multiple === true ? { multiple: true } : {}),
  };
}

export function parseQuestions(text: string): ChatQuestion[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const raw = (parsed as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 4) return null;
  const questions = raw.map(readQuestion);
  return questions.every((question) => question !== null) ? questions : null;
}

/** The user's message for `answers`, or null while a question is open. */
export function questionAnswersMessage(
  questions: readonly ChatQuestion[],
  answers: readonly (readonly string[])[],
): string | null {
  if (answers.length !== questions.length) return null;
  if (answers.some((answer) => answer.length === 0)) return null;
  return questions
    .map(
      (question, index) => `${question.question} ${answers[index]?.join(', ')}`,
    )
    .join('\n');
}

export function QuestionsCard(props: {
  artifact: ChatArtifact;
  token: string;
  /** False once the chat has moved on, or while a turn runs. */
  answerable: boolean;
  onAnswer: (message: string) => Promise<boolean>;
}) {
  const { artifact, token } = props;
  const [questions, setQuestions] = useState<ChatQuestion[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [answers, setAnswers] = useState<string[][]>([]);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!artifact.path) return;
    let cancelled = false;
    void fetchArtifactBlob(token, artifact.path)
      .then((blob) => blob.text())
      .then((text) => {
        if (cancelled) return;
        const read = parseQuestions(text);
        setQuestions(read);
        setAnswers(read ? read.map(() => []) : []);
        setFailed(!read);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [artifact.path, token]);

  if (failed)
    return <p className={css.card}>The questions could not be shown.</p>;
  if (!questions) return null;

  const inactive = sent || busy || !props.answerable;
  const send = async (next: string[][]) => {
    const message = questionAnswersMessage(questions, next);
    if (!message || inactive) return;
    setBusy(true);
    try {
      setSent(await props.onAnswer(message));
    } finally {
      setBusy(false);
    }
  };
  // One question with one answer goes out on the tap.
  const sendsOnTap = questions.length === 1 && !questions[0]?.multiple;
  const choose = (index: number, option: string) => {
    const question = questions[index];
    if (!question) return;
    const current = answers[index] ?? [];
    const picked = question.multiple
      ? current.includes(option)
        ? current.filter((choice) => choice !== option)
        : [...current, option]
      : [option];
    const next = answers.map((answer, i) => (i === index ? picked : answer));
    setAnswers(next);
    if (sendsOnTap) void send(next);
  };

  return (
    <section className={css.card} aria-label="Questions">
      {questions.map((question, index) => (
        <div key={question.question} className={own.question}>
          <strong>{question.question}</strong>
          <div className={css.actions}>
            {question.options.map((option) => {
              const chosen = answers[index]?.includes(option) ?? false;
              return (
                <Button
                  key={option}
                  className={own.option}
                  size="sm"
                  variant={chosen ? 'default' : 'outline'}
                  aria-pressed={chosen}
                  disabled={inactive}
                  onClick={() => choose(index, option)}
                >
                  {option}
                </Button>
              );
            })}
          </div>
        </div>
      ))}
      {sendsOnTap ? null : (
        <div className={css.actions}>
          <Button
            size="sm"
            disabled={inactive || !questionAnswersMessage(questions, answers)}
            onClick={() => void send(answers)}
          >
            Send answers
          </Button>
        </div>
      )}
    </section>
  );
}
