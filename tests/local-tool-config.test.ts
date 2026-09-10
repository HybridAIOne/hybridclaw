import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_LOCAL_STARTER_TOOLS } from '../container/shared/local-tool-config.js';

let runtimeHome: string;
beforeEach(() => {
  runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-local-starters-'));
  vi.stubEnv('HYBRIDCLAW_DATA_DIR', runtimeHome);
  vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.resetModules();
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules();
  fs.rmSync(runtimeHome, { recursive: true, force: true });
});

describe('local starter configuration', () => {
  test('inherits the instance list and replaces it with an agent override', async () => {
    const { updateRuntimeConfig } = await import('../src/config/runtime-config.js');
    const { resolveLocalStarterTools } = await import('../src/agent/local-tool-config.js');
    expect(resolveLocalStarterTools()).toEqual(DEFAULT_LOCAL_STARTER_TOOLS);
    updateRuntimeConfig((draft) => {
      draft.tools.localStarterTools = ['read', 'bash'];
      draft.agents.list = [{ id: 'main' }, { id: 'worker', localStarterTools: ['memory'] }, { id: 'empty', localStarterTools: [] }];
    });
    expect(resolveLocalStarterTools('main')).toEqual(['read', 'bash']);
    expect(resolveLocalStarterTools('worker')).toEqual(['memory']);
    expect(resolveLocalStarterTools('empty')).toEqual([]);
    const stored = JSON.parse(fs.readFileSync(path.join(runtimeHome, 'config.json'), 'utf8'));
    expect(stored.agents.list.find((a: { id: string }) => a.id === 'worker').localStarterTools).toEqual(['memory']);
    updateRuntimeConfig((draft) => { draft.agents.list!.find((a) => a.id === 'worker')!.localStarterTools = undefined; });
    expect(resolveLocalStarterTools('worker')).toEqual(['read', 'bash']);
    const names = resolveLocalStarterTools('main'); names.push('delete');
    expect(resolveLocalStarterTools('main')).toEqual(['read', 'bash']);
  });
  test.each(['instance', 'agent'])('rejects invalid %s lists without replacing config', async (scope) => {
    const { updateRuntimeConfig } = await import('../src/config/runtime-config.js');
    updateRuntimeConfig((draft) => { draft.tools.localStarterTools = ['read']; });
    const configPath = path.join(runtimeHome, 'config.json');
    const before = fs.readFileSync(configPath, 'utf8');
    expect(() => updateRuntimeConfig((draft) => {
      if (scope === 'instance') draft.tools.localStarterTools = Array(10).fill('read');
      else draft.agents.list![0].localStarterTools = ['tool_catalog'];
    })).toThrow();
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
  });
});


test('resolves full/starred mode independently per agent and rejects invalid modes', async () => {
  const { updateRuntimeConfig } = await import('../src/config/runtime-config.js');
  const { resolveLocalToolMode } = await import('../src/agent/local-tool-config.js');
  expect(resolveLocalToolMode('main')).toBe('starred');
  updateRuntimeConfig((draft) => { draft.tools.localToolMode = 'full'; draft.agents.list = [{ id: 'main' }, { id: 'worker', localToolMode: 'starred' }]; });
  expect(resolveLocalToolMode('main')).toBe('full');
  expect(resolveLocalToolMode('worker')).toBe('starred');
  const configPath = path.join(runtimeHome, 'config.json');
  const before = fs.readFileSync(configPath, 'utf8');
  expect(() => updateRuntimeConfig((draft) => { Object.assign(draft.tools, { localToolMode: 'invalid' }); })).toThrow('full or starred');
  expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
});
