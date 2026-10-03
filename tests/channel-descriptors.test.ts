import { describe, expect, test } from 'vitest';
import {
  CHANNEL_DESCRIPTORS,
  getChannelDescriptorForTarget,
  resolveChannelTargetKind,
} from '../src/channels/channel-descriptors.js';
import { getChannelByContextId } from '../src/channels/channel-registry.js';
import { DEFAULT_RUNTIME_CONFIG } from '../src/config/runtime-config.js';
import {
  hasImmediateProactiveDeliveryPath,
  isSupportedProactiveChannelId,
  shouldDropQueuedProactiveMessage,
} from '../src/gateway/proactive-delivery.js';
import {
  resolveResetPolicy,
  resolveSessionResetChannelKind,
} from '../src/session/session-reset.js';

const targets = [
  ['discord', '123456789012345678', true],
  ['discord_webhook', 'discord_webhook:ops', true],
  ['email', 'peer@example.com', true],
  ['imessage', 'imessage:peer@example.com', true],
  ['line', 'line:u' + 'a'.repeat(32), true],
  ['msteams', '19:conversation@thread.tacv2', false],
  ['msteams', 'teams:conversation', false],
  ['msteams', 'a:personal-chat', false],
  ['msteams', 'conversation@thread.v2', false],
  ['signal', 'signal:+14155551212', true],
  ['signal', 'signal:00000000-0000-4000-8000-000000000001', true],
  ['signal', 'signal:group:abcdefgh', true],
  ['slack', 'slack:C12345678', true],
  ['slack_webhook', 'slack_webhook:ops', true],
  ['telegram', 'telegram:-1001234567890:topic:42', true],
  ['threema', 'threema:ABCDEFGH', true],
  ['voice', 'voice:CA1234567890abcdef', false],
  ['whatsapp', '491234567890@s.whatsapp.net', true],
  ['whatsapp', '120363401234567890@g.us', true],
] as const;

describe('channel descriptors', () => {
  test.each(targets)('%s target %s is classified consistently', (kind, target, proactive) => {
    const padded = `  ${target}  `;
    expect(getChannelDescriptorForTarget(padded)?.kind).toBe(kind);
    expect(resolveChannelTargetKind(padded)).toBe(kind);
    expect(getChannelByContextId(padded)?.kind).toBe(kind);
    expect(resolveSessionResetChannelKind(padded)).toBe(kind);
    expect(isSupportedProactiveChannelId(padded)).toBe(proactive);
    expect(hasImmediateProactiveDeliveryPath({ channel_id: padded })).toBe(proactive);
    expect(shouldDropQueuedProactiveMessage({ channel_id: padded, source: 'delegate' })).toBe(!proactive);
  });

  test.each(['', 'unknown', 'signal:invalid', '123', 'discord', 'signal', 'msteams', 'voice', 'telegram'])('does not accept %s as a concrete delivery target', target => {
    expect(getChannelDescriptorForTarget(target)).toBeUndefined();
    expect(isSupportedProactiveChannelId(target)).toBe(false);
  });

  test('every proactive descriptor owns a sender and every channel owns its lifecycle', () => {
    for (const [kind, descriptor] of Object.entries(CHANNEL_DESCRIPTORS)) {
      expect(descriptor.kind).toBe(kind);
      expect(Boolean(descriptor.sendProactive)).toBe(descriptor.supportsProactive);
      expect(descriptor.start).toEqual(expect.any(Function));
      expect(descriptor.stop).toEqual(expect.any(Function));
      expect(descriptor.configChanged).toEqual(expect.any(Function));
    }
  });

  test.each(targets.filter(([kind]) => kind === 'msteams'))('applies the Teams reset override to %s %s', (_, target) => {
    const config = structuredClone(DEFAULT_RUNTIME_CONFIG);
    config.sessionReset.byChannelKind = { msteams: { mode: 'none', idleMinutes: 37 } };
    expect(resolveResetPolicy({ config, channelKind: resolveSessionResetChannelKind(target) })).toMatchObject({ mode: 'none', idleMinutes: 37 });
  });

  test('set-based config allowlists ignore reordering but detect changed membership', () => {
    const prev = structuredClone(DEFAULT_RUNTIME_CONFIG);
    prev.signal.allowFrom = ['user_a', 'user_b'];
    const next = structuredClone(prev);
    next.signal.allowFrom.reverse();
    expect(CHANNEL_DESCRIPTORS.signal.configChanged(next, prev)).toBe(false);
    next.signal.allowFrom[0] = 'user_c';
    expect(CHANNEL_DESCRIPTORS.signal.configChanged(next, prev)).toBe(true);
  });
});
