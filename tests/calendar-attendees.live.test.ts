import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { buildSystemPromptFromHooks } from '../src/agent/prompt-hooks.js';
import { useContainerAgentHarness } from './helpers/container-agent.js';

const runAgent = useContainerAgentHarness();
const live =
  process.env.HYBRIDCLAW_RUN_LIVE_CALENDAR === '1' ? test : test.skip;
const tools = ['read', 'write', 'edit', 'bash'];
const mail = (name: string) => `${name}@example.com`;
const fixture = {
  date: '2028-06-01',
  timezone: 'UTC',
  dailyMeetingLimit: 1,
  existing: [
    {
      id: 'existing-a',
      start: '09:00',
      end: '10:00',
      attendees: [mail('user_a')],
    },
    {
      id: 'existing-g',
      start: '12:00',
      end: '13:00',
      attendees: [mail('user_g')],
    },
  ],
  unavailable: [{ attendee: mail('user_d'), start: '10:00', end: '11:00' }],
  requests: [
    {
      id: 'request-b',
      start: '09:00',
      end: '09:30',
      required: [mail('user_b')],
      optional: [mail('user_a')],
    },
    {
      id: 'request-c',
      start: '10:00',
      end: '10:30',
      required: [mail('user_c')],
      optional: [mail('user_d'), mail('user_f')],
    },
    {
      id: 'request-e',
      start: '14:00',
      end: '14:30',
      required: [mail('user_e')],
      optional: [mail('user_g')],
    },
  ],
};

live(
  'exported participants satisfy availability, conflicts and capacity',
  async () => {
    const base = process.env.HYBRIDCLAW_LIVE_CALENDAR_BASE_URL;
    const model = process.env.HYBRIDCLAW_LIVE_CALENDAR_MODEL;
    const key = process.env.HYBRIDCLAW_LIVE_CALENDAR_API_KEY;
    if (!base || !model || !key)
      throw new Error('Configure the live calendar provider');
    let calls = 0;
    let promptTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    const run = await runAgent(
      async (body) => {
        // Sixteen calls (Codex, 2026-11-26) bound export, repair and validation turns.
        if (++calls > 16)
          throw new Error('Live fixture exceeded sixteen model calls');
        const response = await fetch(
          `${base.replace(/\/+$/, '')}/chat/completions`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${key}`,
            },
            body: JSON.stringify({
              model,
              messages: body.messages,
              tools: body.tools,
              reasoning_effort: 'high',
              max_tokens: 16384,
            }),
            signal: AbortSignal.timeout(90_000),
          },
        );
        if (!response.ok)
          throw new Error(`Calendar fixture provider HTTP ${response.status}`);
        const data = (await response.json()) as {
          choices: { message: Record<string, unknown> }[];
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            prompt_tokens_details?: { cached_tokens?: number };
          };
        };
        promptTokens += data.usage?.prompt_tokens ?? 0;
        outputTokens += data.usage?.completion_tokens ?? 0;
        cachedTokens += data.usage?.prompt_tokens_details?.cached_tokens ?? 0;
        const usageFile = process.env.HYBRIDCLAW_LIVE_CALENDAR_USAGE_FILE;
        if (usageFile)
          fs.appendFileSync(
            usageFile,
            `${JSON.stringify({ calls, promptTokens, outputTokens, cachedTokens, usageReported: Boolean(data.usage) })}\n`,
          );
        const message = data.choices[0]?.message;
        if (!message)
          throw new Error('Calendar fixture received no completion');
        return message;
      },
      {
        allowedTools: tools,
        approvalMode: 'full',
        messages: [
          {
            role: 'system',
            content: buildSystemPromptFromHooks({
              agentId: 'fixture',
              skills: [],
              allowedTools: tools,
            }),
          },
          {
            role: 'user',
            content:
              'Read input.json and write schedule.ics with every existing event and all requested meetings at their supplied times. Use each id as UID and UTC timestamps ending in Z. Availability, overlaps and the daily meeting limit are hard constraints. Include optional attendees whenever those constraints permit. Keep existing events unchanged. Validate the exported calendar before reporting completion.',
          },
        ],
      },
      { 'input.json': JSON.stringify(fixture) },
      { timeoutMs: 180_000 },
    );
    const usageFile = process.env.HYBRIDCLAW_LIVE_CALENDAR_USAGE_FILE;
    if (usageFile)
      fs.writeFileSync(
        `${usageFile}.tools.json`,
        JSON.stringify(
          {
            status: run.output.status,
            error: run.output.error,
            executions: run.output.toolExecutions,
          },
          null,
          2,
        ),
      );
    console.log(
      JSON.stringify({
        fixture: 'calendar-attendees',
        calls,
        promptTokens,
        outputTokens,
        cachedTokens,
      }),
    );
    expect(run.output.status).toBe('success');
    const text = fs
      .readFileSync(path.join(run.dir, 'schedule.ics'), 'utf8')
      .replace(/\r?\n[ \t]/g, '');
    const events = [...text.matchAll(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/g)].map(
      (match) => {
        const property = (name: string) =>
          new RegExp(`^${name}(?:;[^:]*)?:(.*)$`, 'm')
            .exec(match[1])?.[1]
            .trim();
        return {
          id: property('UID'),
          start: property('DTSTART'),
          end: property('DTEND'),
          attendees: [
            ...match[1].matchAll(/^ATTENDEE[^:]*:mailto:([^\s]+)\s*$/gm),
          ].map((x) => x[1]),
        };
      },
    );
    expect(events).toHaveLength(5);
    for (const item of [...fixture.existing, ...fixture.requests]) {
      const event = events.find((x) => x.id === item.id);
      expect(event).toBeDefined();
      expect(event?.start).toBe(`20280601T${item.start.replace(':', '')}00Z`);
      expect(event?.end).toBe(`20280601T${item.end.replace(':', '')}00Z`);
      const expected = 'attendees' in item ? item.attendees : item.required;
      expect(event?.attendees).toEqual(expect.arrayContaining(expected));
    }
    expect(events.find((x) => x.id === 'request-b')?.attendees).toEqual([
      mail('user_b'),
    ]);
    expect(events.find((x) => x.id === 'request-c')?.attendees.sort()).toEqual([
      mail('user_c'),
      mail('user_f'),
    ]);
    expect(events.find((x) => x.id === 'request-e')?.attendees).toEqual([
      mail('user_e'),
    ]);
    expect(events.find((x) => x.id === 'existing-a')?.attendees).toEqual([
      mail('user_a'),
    ]);
    expect(events.find((x) => x.id === 'existing-g')?.attendees).toEqual([
      mail('user_g'),
    ]);
  },
  200_000,
);
