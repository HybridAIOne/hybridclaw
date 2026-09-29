/** Opt-in provider verification: expected shapes are present only in pixels. */
import './helpers/isolate-runtime-home.js';
import { expect, test, vi } from 'vitest';
import type { ChatMessage } from '../container/src/types.js';
import { buildAnthropicSupportingHeaders } from '../src/providers/anthropic-utils.js';
import { injectPdfContextMessages } from '../src/media/pdf-context.js';
import { writeVisualPdfFixture } from './helpers/pdf-visual-fixture.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
useCleanMocks({
  resetModules: true,
  unstubAllEnvs: true,
  unstubAllGlobals: true,
});
const enabled = process.env.HYBRIDCLAW_PDF_LIVE_REMOTE === '1';
const cases = [
  {
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: process.env.HYBRIDCLAW_PDF_LIVE_OPENAI_MODEL || 'gpt-4.1-mini',
    apiKey: process.env.OPENAI_API_KEY,
  },
  {
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    model:
      process.env.HYBRIDCLAW_PDF_LIVE_ANTHROPIC_MODEL || 'claude-haiku-4-5',
    apiKey: process.env.ANTHROPIC_API_KEY,
  },
] as const;
for (const config of cases) {
  test.skipIf(!enabled || !config.apiKey)(
    `${config.provider} receives native PDF follow-up and standalone image in the main model`,
    async () => {
      const root = tempDir();
      await writeVisualPdfFixture(root);
      vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', root);
      const tools = await import('../container/src/tools.js');
      tools.setMediaContext([], [], true);
      const { callRoutedModel } = await import(
        '../container/src/providers/router.js'
      );
      const context = {
        ...config,
        apiKey: config.apiKey!,
        chatbotId: '',
        maxTokens: 1024,
        requestHeaders:
          config.provider === 'anthropic'
            ? buildAnthropicSupportingHeaders({ apiKey: config.apiKey! })
            : {},
      };
      const actualFetch = fetch;
      const requests: { pdfs: number; images: number }[] = [];
      vi.stubGlobal(
        'fetch',
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body));
          const parts = (body.input || body.messages).flatMap(
            (m: { content?: unknown }) =>
              Array.isArray(m.content) ? m.content : [],
          );
          requests.push({
            pdfs: parts.filter(
              (p: { type: string }) =>
                p.type === 'input_file' || p.type === 'document',
            ).length,
            images: parts.filter(
              (p: { type: string }) =>
                p.type === 'input_image' || p.type === 'image',
            ).length,
          });
          return actualFetch(input, init);
        },
      );
      const initial: ChatMessage[] = [
        {
          role: 'user',
          content: 'Summarize ./workshop.pdf in five main ideas.',
        },
      ];
      const summary = await callRoutedModel({
        ...context,
        messages: await injectPdfContextMessages({
          workspaceRoot: root,
          visualMediaAllowed: true,
          messages: initial,
        }),
      });
      expect(summary.choices[0]?.message.content).toBeTruthy();
      const followupMessages = await injectPdfContextMessages({
        workspaceRoot: root,
        visualMediaAllowed: true,
        messages: [
          ...initial,
          summary.choices[0].message,
          {
            role: 'user',
            content:
              'Describe Figure 3. List the colors and shapes from left to right.',
          },
        ],
      });
      expect(followupMessages.at(-1)?.visualAttachments?.[0].pages).toEqual([
        7,
      ]);
      const followup = await callRoutedModel({
        ...context,
        messages: followupMessages,
      });
      const figureAnswer = String(
        followup.choices[0]?.message.content,
      ).toLowerCase();
      expect(figureAnswer).toMatch(
        /red[\s\S]{0,80}circle[\s\S]*blue[\s\S]{0,80}(?:square|rectangle)[\s\S]*green[\s\S]{0,80}triangle/,
      );
      const image = await tools.executeToolWithMetadata(
        'read',
        '{"path":"figure.png"}',
      );
      expect(image.isError).toBe(false);
      const imageMessages: ChatMessage[] = [
        {
          role: 'user',
          content:
            'Read figure.png and list its colors and shapes from left to right.',
        },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'read_image',
              type: 'function',
              function: { name: 'read', arguments: '{"path":"figure.png"}' },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'read_image',
          content: image.output,
          visualAttachments: image.visualAttachments,
        },
      ];
      const standalone = await callRoutedModel({
        ...context,
        messages: imageMessages,
        tools: tools.TOOL_DEFINITIONS.filter((t) => t.function.name === 'read'),
      });
      const imageAnswer = String(
        standalone.choices[0]?.message.content,
      ).toLowerCase();
      expect(imageAnswer).toMatch(
        /red[\s\S]{0,80}circle[\s\S]*blue[\s\S]{0,80}(?:square|rectangle)[\s\S]*green[\s\S]{0,80}triangle/,
      );
      expect(requests).toEqual([
        { pdfs: 1, images: 0 },
        { pdfs: 1, images: 0 },
        { pdfs: 0, images: 1 },
      ]);
      process.stdout.write(
        JSON.stringify({
          provider: config.provider,
          model: config.model,
          requests,
          figureAnswer,
          imageAnswer,
        }) + '\n',
      );
    },
    180_000,
  );
}
