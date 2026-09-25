import { expect, test, vi } from 'vitest';
import plugin from '../plugins/concierge-router/src/index.js';
test('concierge plugin delegates all decisions to shared gateway routing', async () => {
 const api={registerCommand:vi.fn(),registerMiddleware:vi.fn(),writeConfigValue:vi.fn(),getRoutingConfig:()=>({enabled:true,mode:'auto',preference:'balanced',concierge:{model:'test-router'}})};
 plugin.register(api);
 expect(api.registerMiddleware).not.toHaveBeenCalled();
 const command=api.registerCommand.mock.calls[0][0];
 expect(await command.handler([])).toContain('auto');
});
