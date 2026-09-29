/** Opt-in real endpoint test: no text layer contains the expected visual answer. */
import './helpers/isolate-runtime-home.js';
import { expect, test } from 'vitest';
import type { ChatMessage } from '../container/src/types.js';
import { buildSystemPromptFromHooks } from '../src/agent/prompt-hooks.js';
import { injectPdfContextMessages } from '../src/media/pdf-context.js';
import { useContainerAgentHarness } from './helpers/container-agent.js';
import { writeVisualPdfFixture } from './helpers/pdf-visual-fixture.js';

const runAgent = useContainerAgentHarness();
const baseUrl = process.env.HYBRIDCLAW_PDF_LIVE_BASE_URL;
const model = process.env.HYBRIDCLAW_PDF_LIVE_MODEL;
test.skipIf(!baseUrl || !model)(
  'main model chooses PDF page reads and inspects a follow-up and standalone image through native vision',
  async () => {
    let initial: ChatMessage[] = [];
    const run = await runAgent(
      async (body) => {
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...body,
            model,
            stream: false,
            max_tokens: 4096,
            temperature: 0,
          }),
          signal: AbortSignal.timeout(120_000),
        });
        if (!response.ok)
          throw new Error(
            `Live endpoint ${response.status}: ${await response.text()}`,
          );
        return (await response.json()).choices[0].message;
      },
      {
        provider: 'vllm',
        model,
        visualMediaAllowed: true,
        skipContainerSystemPrompt: false,
      },
      {},
      {
        timeoutMs: 180_000,
        prepare: async (dir) => {
          await writeVisualPdfFixture(dir);
          const systemPrompt = buildSystemPromptFromHooks({
            agentId: 'test-agent',
            skills: [],
            runtimeInfo: {
              model: `vllm/${model}`,
              channelType: 'web',
              workspacePath: dir,
            },
          });
          initial = [
            { role: 'system', content: systemPrompt },
            {
              role: 'user',
              content: "What's inside ./workshop.pdf? Give me five main ideas.",
            },
          ];
          return {
            messages: await injectPdfContextMessages({
              messages: initial,
              workspaceRoot: dir,
              visualMediaAllowed: true,
            }),
          };
        },
      },
    );
    expect(run.output.status).toBe('success');
    const firstRequests = run.requests.length;
    const followupMessages = await injectPdfContextMessages({
      workspaceRoot: run.dir,
      visualMediaAllowed: true,
      messages: [
        ...initial,
        ...(run.output.toolHistory || []),
        { role: 'assistant', content: run.output.result || '' },
        {
          role: 'user',
          content:
            'What does the sequence of symbols depict? Describe its colors and shapes from left to right.',
        },
      ],
    });
    expect(followupMessages.at(-1)?.visualAttachments).toBeUndefined();
    const followup = await run.followup({ messages: followupMessages });
    expect(followup.status).toBe('success');
    const calls = run.requests
      .flatMap((r) => r.messages)
      .filter((m) => m.role === 'assistant')
      .flatMap((m) => m.tool_calls || []);
    const uniqueCalls = [...new Map(calls.map((c) => [c.id, c])).values()];
    expect(uniqueCalls.map((c) => c.function.name)).not.toContain(
      'vision_analyze',
    );
    expect(uniqueCalls.map((c) => c.function.name)).not.toContain('bash');
    const imageCounts = run.requests.map(
      (r) =>
        r.messages
          .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
          .filter((p) => p.type === 'image_url').length,
    );
    expect(imageCounts[0]).toBe(4);
    expect(imageCounts.slice(firstRequests).some((n) => n > 0)).toBe(true);
    expect(
      [...(run.output.toolHistory || []), ...(followup.toolHistory || [])].some((message) =>
        message.visualAttachments?.some((ref) => ref.pages.includes(7)),
      ),
    ).toBe(true);
    for (const word of ['red', 'circle', 'blue', 'square', 'green', 'triangle'])
      expect(followup.result?.toLowerCase()).toContain(word);

    const standalone = await run.followup({
      messages: [
        initial[0],
        {
          role: 'user',
          content:
            'Read ./figure.png and describe the colors and shapes from left to right.',
        },
      ],
    });
    expect(standalone.status).toBe('success');
    for (const word of ['red', 'circle', 'blue', 'square', 'green', 'triangle'])
      expect(standalone.result?.toLowerCase()).toContain(word);
    expect(
      standalone.toolHistory?.some((m) =>
        m.visualAttachments?.some((ref) => ref.pages.length === 0),
      ),
    ).toBe(true);
    process.stdout.write(
      JSON.stringify({
        mainModel: model,
        initialRequestImages: imageCounts[0],
        followupRequestImages: imageCounts.slice(firstRequests),
        pdfTools: uniqueCalls.map((c) => ({
          name: c.function.name,
          arguments: JSON.parse(c.function.arguments),
        })),
        figureAnswer: followup.result,
        standaloneImageAnswer: standalone.result,
      }) + '\n',
    );
  },
  360_000,
);
