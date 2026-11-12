/**
 * `ask_questions`: what the agent needs to know from the user before it goes
 * on. The HybridAI app shows the questions as one card under the reply that
 * steps through them, with choices to tap and a field for the user's own
 * answer, and sends the answers back as the user's next message. The tool only
 * writes one JSON file into `questions/` and returns it as an artifact with
 * its own media type.
 */
import { createHash } from 'node:crypto';

import type { ToolDefinition } from '../types.js';

export const ASK_QUESTIONS_TOOL = 'ask_questions';
export const QUESTIONS_MIME_TYPE = 'application/vnd.hybridai.questions+json';

// What the app's card shows; it drops a file outside these limits.
const QUESTIONS_MAX = 4;
const QUESTION_MAX = 200;
const OPTIONS_MIN = 2;
const OPTIONS_MAX = 5;
const OPTION_MAX = 80;

export interface Question {
  question: string;
  options: string[];
  /** Several choices may apply. */
  multiple?: true;
}

function oneLine(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`${field} must be text.`);
  const text = value.trim().replace(/\s+/g, ' ');
  if (!text) throw new Error(`${field} must not be empty.`);
  if (text.length > max)
    throw new Error(`${field} must be at most ${max} characters.`);
  return text;
}

export function normalizeQuestions(args: Record<string, unknown>): Question[] {
  const raw = args.questions;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > QUESTIONS_MAX) {
    throw new Error(
      `\`questions\` must hold one to ${QUESTIONS_MAX} questions.`,
    );
  }
  return raw.map((entry, index) => {
    const field = `Question ${index + 1}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${field} must be an object.`);
    }
    const { question, options, multiple } = entry as Record<string, unknown>;
    if (
      !Array.isArray(options) ||
      options.length < OPTIONS_MIN ||
      options.length > OPTIONS_MAX
    ) {
      throw new Error(
        `${field} needs ${OPTIONS_MIN} to ${OPTIONS_MAX} options.`,
      );
    }
    const choices = options.map((option) =>
      oneLine(option, `An option of question ${index + 1}`, OPTION_MAX),
    );
    if (new Set(choices).size !== choices.length) {
      throw new Error(`${field} has the same option twice.`);
    }
    return {
      question: oneLine(question, field, QUESTION_MAX),
      options: choices,
      ...(multiple === true ? { multiple: true as const } : {}),
    };
  });
}

export function runAskQuestions(
  args: Record<string, unknown>,
  writeFile: (relativePath: string, contents: string) => void,
): string {
  const questions = normalizeQuestions(args);
  const contents = `${JSON.stringify({ questions }, null, 2)}\n`;
  const hash = createHash('sha256').update(contents).digest('hex').slice(0, 8);
  const relativePath = `questions/${hash}.json`;
  writeFile(relativePath, contents);
  return JSON.stringify({
    success: true,
    path: relativePath,
    note: 'The app shows these questions as a card under your reply, and the answers arrive as the user’s next message. End your turn now with one short sentence that says what you need to know and why. Do not repeat the questions or their options, do not link the file, and do not go on with the task until the answers are there.',
    artifacts: [
      {
        path: relativePath,
        filename: 'questions.json',
        mimeType: QUESTIONS_MIME_TYPE,
      },
    ],
  });
}

export const ASK_QUESTIONS_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: ASK_QUESTIONS_TOOL,
    description:
      'Ask the user up to four questions whose answers you need before you go on, each with choices to tap. The app shows them as one card under your reply; the user can also type an answer of their own to each, so never add an "Other" option. The answers arrive as their next message. Call it once and end your turn.',
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description:
            'The questions in the order to ask them, in the user’s language',
          items: {
            type: 'object',
            properties: {
              question: {
                type: 'string',
                description: `One question, at most ${QUESTION_MAX} characters`,
              },
              options: {
                type: 'array',
                items: { type: 'string' },
                description: `Two to five different short answers to tap, each at most ${OPTION_MAX} characters, the likeliest first`,
              },
              multiple: {
                type: 'boolean',
                description: 'True when several options may apply at once',
              },
            },
            required: ['question', 'options'],
          },
        },
      },
      required: ['questions'],
    },
  },
};
