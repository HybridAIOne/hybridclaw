import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';

const config = vi.hoisted(() => ({ DATA_DIR: '' }));
vi.mock('../src/config/config.js', () => config);
vi.mock('../src/gateway/schedule-command.js', () => ({ chatSafeJson: JSON.stringify }));
import { handlePreferencesCommand } from '../src/preferences/preferences-command.js';
import { mergePreferences, readPreferences, renderPreferences, runPreferenceTool } from '../src/preferences/preferences.js';
import { beginTurnUser, currentTurnUser } from '../src/session/turn-user.js';

const renderSessionPreferences = (id: string) => renderPreferences(currentTurnUser(id)?.userId);

config.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-preferences-'));
afterAll(() => fs.rmSync(config.DATA_DIR, { recursive: true, force: true }));
beforeEach(() => fs.rmSync(path.join(config.DATA_DIR, 'preferences'), { recursive: true, force: true }));
const event = (id = 'e1', key = 'feed:story', kind = 'like', at = 1) => ({ id, key, kind, text: 'Cycling', at });

describe('runtime preferences', () => {
  test('one durable record merges iOS, Android, chat and retry events', () => {
    mergePreferences('u1', [event()]);
    mergePreferences('u1', [event('e2', 'idea:tax', 'dismiss', 2)]);
    const end = beginTurnUser('chat', 'u1');
    expect(runPreferenceTool({ sessionId: 'chat', action: 'set', key: 'coverage', text: 'Less crypto, more cycling' }).ok).toBe(true);
    end();
    expect(mergePreferences('u1', [event()])).toEqual(['e1']);
    expect(readPreferences('u1')).toHaveLength(3);
    const scheduled = beginTurnUser('tomorrow', 'u1');
    expect(renderSessionPreferences('tomorrow')).toContain('Less crypto, more cycling');
    expect(renderSessionPreferences('tomorrow')).toContain('dismiss');
    scheduled();
    expect(renderSessionPreferences('tomorrow')).toBe('');
  });
  test('neutral removes taste and an old retry or one-time import cannot restore it', () => {
    mergePreferences('u1', [event()]);
    mergePreferences('u1', [event('e2', 'feed:story', 'neutral', 5)]);
    mergePreferences('u1', [event(), event('import', 'feed:story', 'hide', 0)]);
    expect(readPreferences('u1')).toEqual([event('e2', 'feed:story', 'neutral', 5)]);
    const end = beginTurnUser('chat', 'u1');
    expect(renderSessionPreferences('chat')).not.toContain('Cycling');
    end();
  });
  test('users are isolated, tool-supplied owners are ignored and overlapping owners fail closed', () => {
    mergePreferences('u1', [event()]);
    expect(readPreferences('u2')).toEqual([]);
    expect(runPreferenceTool({ sessionId: 'none', userId: 'u1', action: 'get' }).ok).toBe(false);
    const end = beginTurnUser('chat', 'u2');
    expect(runPreferenceTool({ sessionId: 'chat', userId: 'u1', action: 'get' }).result).toBe('[]');
    const overlap = beginTurnUser('chat', 'u1');
    expect(runPreferenceTool({ sessionId: 'chat', action: 'get' }).ok).toBe(false);
    overlap(); end();
  });
  test.each(['read', 'saved', 'discussion', 'execute'])('rejects non-feedback action %s atomically', kind => {
    expect(() => mergePreferences('u1', [event(), event('bad', 'other', kind)])).toThrow();
    expect(readPreferences('u1')).toEqual([]);
  });
  test('rejects invalid limits, timestamps and missing owners', () => {
    expect(() => mergePreferences('', [event()])).toThrow();
    expect(() => mergePreferences('u1', Array(101).fill(event()))).toThrow();
    expect(() => mergePreferences('u1', [{ ...event(), text: 'x'.repeat(2001) }])).toThrow();
    expect(() => mergePreferences('u1', [{ ...event(), at: Date.now() + 999999 }])).toThrow();
    expect(readPreferences('u1')).toEqual([]);
  });
  test('command preserves Unicode, whitespace and quotes through a relay', () => {
    const events = [{ ...event(), text: 'Mehr Räder\nweniger "Krypto"' }];
    const token = Buffer.from(JSON.stringify(events)).toString('base64url');
    const command = (args: string[], userId: string | null = 'u1') => handlePreferencesCommand({ sessionId: 'app', channelId: 'web', guildId: null, userId, args });
    expect(JSON.parse(command(['preferences', 'sync', token, '--json']).text)).toEqual({ version: 1, acknowledged: ['e1'] });
    expect(readPreferences('u1')).toEqual(events);
    expect(command(['preferences', 'sync', token], null).kind).toBe('error');
    expect(command(['preferences', 'sync', 'bad%%%']).kind).toBe('error');
  });
});
