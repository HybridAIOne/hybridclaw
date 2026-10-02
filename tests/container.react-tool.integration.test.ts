import { describe, expect, test } from 'vitest';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const runContainerAgent = useContainerAgentHarness();

function call(id: string, name: string, args: Record<string, unknown>) {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

function reply(content: string | null, calls: ReturnType<typeof call>[]) {
  return { role: 'assistant', content, tool_calls: calls };
}

const react = (emoji: string) => call('call_react', 'react', { emoji });

describe('a reaction ends the turn without another model call', () => {
  test('the text written with the reaction is the reply', async () => {
    const { requests, output } = await runContainerAgent(
      [reply('Congratulations on the new job!', [react('🎉')])],
      { localToolMode: 'full' },
    );
    expect(requests).toHaveLength(1);
    expect(output.status).toBe('success');
    expect(output.result).toBe('Congratulations on the new job!');
    expect(output.toolExecutions).toMatchObject([
      { name: 'react', isError: false },
    ]);
  });

  test('a reaction alone is the whole answer', async () => {
    const { requests, output } = await runContainerAgent(
      [reply(null, [react('❤️')])],
      { localToolMode: 'full' },
    );
    expect(requests).toHaveLength(1);
    expect(output.status).toBe('success');
    expect(output.result || '').toBe('');
  });

  test('a failed reaction or one next to other tools lets the turn go on', async () => {
    const failed = await runContainerAgent([reply(null, [react('nice')])], {
      localToolMode: 'full',
    });
    expect(failed.requests).toHaveLength(2);
    expect(failed.output.result).toBe('done');
    expect(failed.output.toolExecutions?.[0]).toMatchObject({
      name: 'react',
      isError: true,
    });

    const working = await runContainerAgent(
      [
        reply(null, [
          react('👀'),
          call('call_read', 'read', { path: 'notes.txt' }),
        ]),
      ],
      { localToolMode: 'full' },
      { 'notes.txt': 'synthetic notes' },
    );
    expect(working.requests).toHaveLength(2);
    expect(working.output.result).toBe('done');
  });
});
