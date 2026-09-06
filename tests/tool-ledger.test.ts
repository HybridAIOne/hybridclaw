import { describe, expect, it } from 'vitest';

import type { ToolExecution } from '../src/types/execution.js';
import {
  appendToolLedgerTrailer,
  buildToolLedger,
  parseToolLedger,
  renderToolLedgerTrailer,
  serializeToolLedger,
  TOOL_LEDGER_MAX_CHARS,
  TOOL_LEDGER_MAX_ENTRIES,
} from '../src/types/tool-ledger.js';

function execution(overrides: Partial<ToolExecution>): ToolExecution {
  return {
    name: 'tool',
    arguments: '{}',
    result: '',
    durationMs: 1,
    ...overrides,
  };
}

describe('buildToolLedger', () => {
  it('records a successful send with its identifying arguments', () => {
    const ledger = buildToolLedger([
      execution({
        name: 'message',
        arguments: JSON.stringify({
          action: 'send',
          channel: 'whatsapp',
          to: '+49 151 0000000',
          text: 'Hello there, long message body that must not leak',
        }),
        result: JSON.stringify({
          ok: true,
          action: 'send',
          recipient: '+49 151 0000000',
          deliveryStatus: 'accepted_by_linked_device',
        }),
      }),
    ]);

    expect(ledger).toEqual([
      {
        tool: 'message',
        args: 'send channel:whatsapp to:+49 151 0000000',
        ok: true,
        note: expect.stringContaining('accepted_by_linked_device'),
      },
    ]);
    expect(ledger[0]?.note).not.toContain('long message body');
  });

  it('marks isError, blocked, "Error:" and ok:false results as failures', () => {
    const ledger = buildToolLedger([
      execution({ name: 'write', isError: true, result: 'disk full' }),
      execution({
        name: 'bash',
        blocked: true,
        blockedReason: 'denied by policy',
        result: '',
      }),
      execution({
        name: 'cron',
        arguments: JSON.stringify({ action: 'add', cron: '0 7 * * *' }),
        result: 'Error: invalid cron expression',
      }),
      execution({
        name: 'message',
        result: JSON.stringify({ ok: false, error: 'recipient unknown' }),
      }),
    ]);

    expect(ledger.map((entry) => [entry.ok, entry.note])).toEqual([
      [false, 'disk full'],
      [false, 'denied by policy'],
      [false, 'invalid cron expression'],
      [false, 'recipient unknown'],
    ]);
    expect(ledger[2]?.args).toBe('add cron:0 7 * * *');
  });

  it('truncates long results and collapses whitespace', () => {
    const ledger = buildToolLedger([
      execution({ name: 'read', result: `line one\n\n${'x'.repeat(500)}` }),
    ]);
    const note = ledger[0]?.note || '';
    expect(note.length).toBeLessThanOrEqual(160);
    expect(note.startsWith('line one x')).toBe(true);
    expect(note.endsWith('…')).toBe(true);
  });

  it('redacts secrets from arguments and results', () => {
    const ledger = buildToolLedger([
      execution({
        name: 'http',
        arguments: JSON.stringify({
          url: 'https://example.com?api_key=sk-1234567890abcdefghijklmnopqrstuv',
        }),
        result: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789',
      }),
    ]);
    expect(ledger[0]?.args).not.toContain('sk-1234567890abcdefghijklmnopqrstuv');
    expect(ledger[0]?.note).not.toContain(
      'abcdefghijklmnopqrstuvwxyz0123456789',
    );
  });

  it('caps the entry count and the total rendered size', () => {
    const many = Array.from({ length: TOOL_LEDGER_MAX_ENTRIES + 10 }, (_, i) =>
      execution({ name: `tool${i}`, result: 'ok' }),
    );
    expect(buildToolLedger(many)).toHaveLength(TOOL_LEDGER_MAX_ENTRIES);

    const heavy = Array.from({ length: 20 }, () =>
      execution({ name: 'read', result: 'y'.repeat(200) }),
    );
    const ledger = buildToolLedger(heavy);
    const rendered = ledger
      .map((entry) => `${entry.tool} → ok: ${entry.note}`)
      .join('');
    expect(ledger.length).toBeLessThan(20);
    expect(rendered.length).toBeLessThanOrEqual(TOOL_LEDGER_MAX_CHARS);
  });

  it('returns an empty ledger for turns without tool calls', () => {
    expect(buildToolLedger([])).toEqual([]);
    expect(buildToolLedger(undefined)).toEqual([]);
    expect(serializeToolLedger([])).toBeNull();
  });
});

describe('tool ledger serialization and rendering', () => {
  it('round-trips through JSON and drops malformed entries', () => {
    const ledger = buildToolLedger([
      execution({ name: 'memory', arguments: '{"action":"append"}', result: 'ok' }),
    ]);
    expect(parseToolLedger(serializeToolLedger(ledger))).toEqual(ledger);
    expect(parseToolLedger(null)).toBeUndefined();
    expect(parseToolLedger('not json')).toBeUndefined();
    expect(parseToolLedger('[{"ok":true},{"tool":"x","ok":"yes"}]')).toEqual([
      { tool: 'x', ok: false },
    ]);
  });

  it('renders a deterministic trailer with a failure summary', () => {
    const ledger = [
      { tool: 'message', args: 'send to:+49', ok: true, note: 'accepted' },
      { tool: 'cron', args: 'add', ok: false, note: 'invalid cron' },
    ];
    const trailer = renderToolLedgerTrailer(ledger);
    expect(trailer).toBe(
      '[tool ledger: 2 call(s), 1 failed; message send to:+49 → ok: accepted; cron add → error: invalid cron]',
    );
    expect(renderToolLedgerTrailer(ledger)).toBe(trailer);
    expect(appendToolLedgerTrailer('Sent it.\n', ledger)).toBe(
      `Sent it.\n\n${trailer}`,
    );
    expect(appendToolLedgerTrailer('Plain answer', [])).toBe('Plain answer');
    expect(renderToolLedgerTrailer(undefined)).toBe('');
  });
});
