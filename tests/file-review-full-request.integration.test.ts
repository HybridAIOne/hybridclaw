import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import type { ChatMessage } from '../container/src/types.js';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const runAgent = useContainerAgentHarness();
const original = 'Garden notes\nWater weekly.\n';
const replacement = 'Release notes\nAdded offline mode.\n';
const create = 'Create release notes in report.md.';
const replace = 'Replace the garden notes in report.md with release notes.';
const preserve =
  'Keep the garden notes unchanged. Create release-notes.md instead.';
const background =
  'Background: the release adds an offline reading mode.\n'.repeat(45);

function write(id: string, checked: boolean) {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id,
        type: 'function',
        function: {
          name: 'write',
          arguments: JSON.stringify({
            path: 'report.md',
            contents: replacement,
            ...(checked ? { overwrite: true, expected_content: original } : {}),
          }),
        },
      },
    ],
  };
}

test.each([
  {
    name: 'short replacement control',
    initial: replace,
    tail: '',
    padding: '',
    multipart: false,
    allowed: true,
  },
  {
    name: 'replacement after character 1200',
    initial: create,
    tail: replace,
    padding: background,
    multipart: false,
    allowed: true,
  },
  {
    name: 'withdrawal after character 1200',
    initial: replace,
    tail: preserve,
    padding: background,
    multipart: false,
    allowed: false,
  },
  {
    name: 'replacement in the last text part',
    initial: create,
    tail: replace,
    padding: background,
    multipart: true,
    allowed: true,
  },
  {
    name: 'withdrawal in the last text part',
    initial: replace,
    tail: preserve,
    padding: background,
    multipart: true,
    allowed: false,
  },
])(
  'preservation review retains $name',
  async ({ initial, tail, padding, multipart, allowed }) => {
    const parts = [initial, padding, tail].filter(Boolean);
    const content: ChatMessage['content'] = multipart
      ? parts.map((text) => ({ type: 'text' as const, text }))
      : parts.join('\n\n');
    const expected = multipart ? parts.join('\n') : content;
    let primary = 0;
    const reviews: string[] = [];
    const run = await runAgent(
      async (body) => {
        if ((body.tools ?? []).length === 0) {
          const prompt = JSON.parse(String(body.messages.at(-1)?.content))
            .user_request as string;
          reviews.push(prompt);
          return {
            role: 'assistant',
            content: JSON.stringify({
              decision:
                prompt.lastIndexOf(replace) > prompt.lastIndexOf(preserve)
                  ? 'allow'
                  : 'reject',
              reason: 'Follow the final fixture instruction.',
            }),
          };
        }
        if (primary++ < 2) return write(`write-${primary}`, primary === 2);
        return { role: 'assistant', content: 'Finished permitted work.' };
      },
      {
        approvalMode: 'full',
        messages: [
          { role: 'user', content: 'Earlier unrelated instruction.' },
          { role: 'assistant', content: 'Earlier answer.' },
          { role: 'user', content },
          {
            role: 'system',
            content: 'Runtime context does not replace user intent.',
          },
        ],
      },
      { 'report.md': original },
    );
    expect(reviews).toEqual([expected]);
    expect(run.output.effectiveUserPrompt).toBe(
      String(expected).replace(/\s+/g, ' ').trim().slice(0, 1_200),
    );
    expect(fs.readFileSync(path.join(run.dir, 'report.md'), 'utf8')).toBe(
      allowed ? replacement : original,
    );
    expect(run.output.pendingApproval).toBeUndefined();
  },
  20000,
);
