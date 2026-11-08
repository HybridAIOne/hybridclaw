import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const runAgent = useContainerAgentHarness();
const original = 'Garden notes\nWater weekly.\n';
const replacement = 'Software release notes\nAdded offline mode.\n';
const createRequest = 'Create software release notes in report.md.';
const replaceRequest =
  'Replace report.md with software release notes. Discard the garden notes.';

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
  { rootRequest: createRequest, allowed: false },
  { rootRequest: replaceRequest, allowed: true },
  { rootRequest: undefined, allowed: false },
])(
  'a delegated conflicting write respects root intent: $allowed / $rootRequest',
  async ({ rootRequest, allowed }) => {
    let primaryCalls = 0;
    const reviews: string[] = [];
    const run = await runAgent(
      async (body) => {
        if ((body.tools ?? []).length === 0) {
          const request = JSON.parse(String(body.messages.at(-1)?.content));
          reviews.push(request.user_request);
          return {
            role: 'assistant',
            content: JSON.stringify({
              decision:
                request.user_request === replaceRequest ? 'allow' : 'reject',
              reason: 'The review follows the supplied user request.',
            }),
          };
        }
        if (primaryCalls++ < 2)
          return write(`write-${primaryCalls}`, primaryCalls === 2);
        return { role: 'assistant', content: 'Finished permitted work.' };
      },
      {
        sessionId: 'child',
        fileWriteGuardSessionId: 'parent',
        ...{ fileWriteGuardUserPrompt: rootRequest },
        approvalMode: 'full',
        messages: [{ role: 'user', content: replaceRequest }],
      },
      { 'report.md': original },
    );
    expect(reviews).toEqual(rootRequest === undefined ? [] : [rootRequest]);
    expect(fs.readFileSync(path.join(run.dir, 'report.md'), 'utf8')).toBe(
      allowed ? replacement : original,
    );
    expect(run.output.pendingApproval).toBeUndefined();
  },
  20000,
);

test('a reused worker cannot retain a delegated replacement request omitted from its next input', async () => {
  let primary = 0;
  const reviews: string[] = [];
  const later = 'Unrelated invoice notes\n';
  const calls = [
    { contents: replacement },
    { contents: replacement, overwrite: true, expected_content: original },
    null,
    { contents: later },
    { contents: later, overwrite: true, expected_content: replacement },
    null,
  ];
  const run = await runAgent(
    async (body) => {
      if ((body.tools ?? []).length === 0) {
        reviews.push(
          JSON.parse(String(body.messages.at(-1)?.content)).user_request,
        );
        return {
          role: 'assistant',
          content: '{"decision":"allow","reason":"Fixture verdict"}',
        };
      }
      const args = calls[primary++];
      if (!args)
        return { role: 'assistant', content: 'Finished permitted work.' };
      return {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: `write-${primary}`,
            type: 'function',
            function: {
              name: 'write',
              arguments: JSON.stringify({ path: 'report.md', ...args }),
            },
          },
        ],
      };
    },
    {
      sessionId: 'child',
      fileWriteGuardSessionId: 'parent',
      approvalMode: 'full',
      fileWriteGuardUserPrompt: replaceRequest,
      messages: [{ role: 'user', content: replaceRequest }],
    },
    { 'report.md': original },
  );
  expect(fs.readFileSync(path.join(run.dir, 'report.md'), 'utf8')).toBe(
    replacement,
  );
  const next = await run.followup({
    fileWriteGuardUserPrompt: undefined,
    messages: [
      {
        role: 'user',
        content: 'Replace report.md with unrelated invoice notes.',
      },
    ],
  });
  expect(primary).toBe(6);
  expect(reviews).toEqual([replaceRequest]);
  expect(next.pendingApproval).toBeUndefined();
  expect(
    next.toolExecutions?.find((row) =>
      row.approvalActionKey?.startsWith('file-preservation-review:'),
    ),
  ).toMatchObject({ blocked: true });
  expect(fs.readFileSync(path.join(run.dir, 'report.md'), 'utf8')).toBe(
    replacement,
  );
}, 20000);
