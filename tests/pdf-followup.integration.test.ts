import { expect, test } from 'vitest';
import { injectPdfContextMessages } from '../src/media/pdf-context.js';
import { useContainerAgentHarness } from './helpers/container-agent.js';
import { writeVisualPdfFixture } from './helpers/pdf-visual-fixture.js';
const runAgent = useContainerAgentHarness();
const read = (id: string, args: Record<string, string>) => ({
  role: 'assistant',
  content: null,
  tool_calls: [
    {
      id,
      type: 'function',
      function: { name: 'read', arguments: JSON.stringify(args) },
    },
  ],
});
test('real worker delivers preview, searched PDF page and image pixels through main-model IPC history', async () => {
  const run = await runAgent(
    [
      { role: 'assistant', content: 'Five workshop ideas.' },
      read('search', { path: 'workshop.pdf', query: 'sequence of symbols' }),
      read('page', { path: 'workshop.pdf', pages: '7' }),
      read('image', { path: 'figure.png' }),
      { role: 'assistant', content: 'Figure inspected.' },
    ],
    { visualMediaAllowed: true },
    {},
    {
      prepare: async (dir) => {
        await writeVisualPdfFixture(dir);
        return {
          messages: await injectPdfContextMessages({
            messages: [{ role: 'user', content: 'Summarize ./workshop.pdf' }],
            workspaceRoot: dir,
            visualMediaAllowed: true,
          }),
        };
      },
    },
  );
  expect(run.output.status).toBe('success');
  const result = await run.followup({
    messages: [
      { role: 'user', content: 'Describe the sequence of symbols.' },
    ],
  });
  expect(result.status).toBe('success');
  expect(result.result).toBe('Figure inspected.');
  const imageCounts = run.requests.map(
    (r) =>
      r.messages
        .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
        .filter((p) => p.type === 'image_url').length,
  );
  expect(imageCounts).toEqual([4, 0, 0, 1, 2]);
  const search = result.toolHistory?.find((m) => m.tool_call_id === 'search');
  expect(JSON.parse(String(search?.content))).toMatchObject({
    matches: [{ page: 7 }],
  });
  expect(
    result.toolHistory?.find((m) => m.tool_call_id === 'page')
      ?.visualAttachments?.[0].pages,
  ).toEqual([7]);
  expect(
    result.toolHistory?.find((m) => m.tool_call_id === 'image')
      ?.visualAttachments?.[0].pages,
  ).toEqual([]);
  expect(JSON.stringify(result.toolHistory)).not.toContain('data:image');
}, 30_000);
