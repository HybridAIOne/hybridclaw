import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

vi.mock('../src/agents/agent-registry.js', () => ({ listAgents: () => [{ id: 'main', name: 'Main' }, { id: 'worker', name: 'Worker' }, { id: 'archived', archived: true }] }));
let runtimeHome: string;
beforeEach(() => {
  runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-context-admin-'));
  vi.stubEnv('HYBRIDCLAW_DATA_DIR', runtimeHome);
  vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
  vi.resetModules();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules(); fs.rmSync(runtimeHome, { recursive: true, force: true }); });

test.each(['tools', 'skills'] as const)('persists %s instance settings, independent agent overrides and explicit inheritance without altering permission', async (kind) => {
  const { updateRuntimeConfig, getRuntimeConfig } = await import('../src/config/runtime-config.js');
  updateRuntimeConfig((draft) => { draft.tools.disabled = ['bash']; draft.skills.disabled = ['pdf']; draft.agents.list = [{ id: 'main', tools: ['read'], skills: ['docx'] }]; });
  const api = await import('../src/gateway/gateway-local-context-settings.js');
  const first = api.saveLocalContextSettings(kind, { agentId: null, mode: 'starred', starred: ['read'] });
  expect(first.instance).toEqual({ mode: 'starred', starred: ['read'] });
  expect(first.agents.map((a) => a.id)).toEqual(['main', 'worker']);
  const agent = api.saveLocalContextSettings(kind, { agentId: 'worker', mode: 'full', starred: [] }).agents.find((a) => a.id === 'worker');
  expect(agent).toMatchObject({ mode: 'full', starred: [] });
  expect(api.getLocalContextSettings(kind).instance).toEqual(first.instance);
  const inherited = api.saveLocalContextSettings(kind, { agentId: 'worker', mode: null, starred: null }).agents.find((a) => a.id === 'worker');
  expect(inherited).toMatchObject({ mode: null, starred: null });
  expect(getRuntimeConfig().tools.disabled).toEqual(['bash']);
  expect(getRuntimeConfig().skills.disabled).toEqual(['pdf']);
  expect(getRuntimeConfig().agents.list?.find((a) => a.id === 'main')).toMatchObject({ tools: ['read'], skills: ['docx'] });
});

test.each(['tools', 'skills'] as const)('rejects malformed %s updates without touching stored state', async (kind) => {
  const { updateRuntimeConfig } = await import('../src/config/runtime-config.js');
  updateRuntimeConfig(() => {});
  const api = await import('../src/gateway/gateway-local-context-settings.js');
  const configPath = path.join(runtimeHome, 'config.json');
  const before = fs.readFileSync(configPath, 'utf8');
  for (const body of [null, [], {}, { agentId: null, mode: 'bad', starred: [] }, { agentId: null, mode: null, starred: null }, { agentId: 'missing', mode: 'full', starred: [] }, { agentId: 'archived', mode: 'full', starred: [] }, { agentId: null, mode: 'starred', starred: Array.from({ length: 10 }, (_, i) => `entry${i}`) }, { agentId: null, mode: 'full', starred: ['read', 'read'] }, { agentId: null, mode: 'full', starred: [], disabled: [] }]) {
    expect(() => api.saveLocalContextSettings(kind, body)).toThrow();
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
  }
});
