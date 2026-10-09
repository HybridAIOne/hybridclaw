import { expect, test, vi } from 'vitest';
import { tryHandlePluginDefinedGatewayCommand } from '../src/gateway/gateway-plugin-service.js';
import type { GatewayCommandRequest } from '../src/gateway/gateway-types.js';
import type { PluginManager } from '../src/plugins/plugin-manager.js';

function run(req: Partial<GatewayCommandRequest>) {
  const handler = vi.fn(async () => 'dialing');
  const pluginManager = {
    findCommand: () => ({
      name: 'voice',
      adminAction: 'admin.channels.write',
      handler,
    }),
  } as unknown as PluginManager;
  return {
    handler,
    result: tryHandlePluginDefinedGatewayCommand({
      command: 'voice',
      req: {
        sessionId: 'session-1',
        guildId: null,
        channelId: 'web',
        args: ['voice', 'call', '+15550001111'],
        ...req,
      },
      pluginManager,
    }),
  };
}

test.each([
  { surface: 'a Discord channel', req: { guildId: 'guild-1', channelId: 'discord:1' } },
  { surface: 'a WhatsApp DM', req: { channelId: '15550001111@s.whatsapp.net' } },
  {
    surface: 'a web token without the admin action',
    req: { adminActions: ['voice.session'] },
  },
])('an adminAction plugin command is refused from $surface', async ({ req }) => {
  const { handler, result } = run(req);

  await expect(result).resolves.toMatchObject({
    kind: 'error',
    title: 'Command Restricted',
  });
  expect(handler).not.toHaveBeenCalled();
});

test.each([
  { surface: 'the TUI', req: { channelId: 'tui' } },
  { surface: 'a local web session', req: { channelId: 'web' } },
  {
    surface: 'a web token holding the admin action',
    req: { adminActions: ['admin.channels.write'] },
  },
])('an adminAction plugin command runs from $surface', async ({ req }) => {
  const { handler, result } = run(req);

  await expect(result).resolves.toMatchObject({ text: 'dialing' });
  expect(handler).toHaveBeenCalledWith(['call', '+15550001111'], {
    sessionId: 'session-1',
    channelId: req.channelId ?? 'web',
    userId: undefined,
    username: null,
    guildId: null,
  });
});
