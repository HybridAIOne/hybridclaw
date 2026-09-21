import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const { runAgentMock, callAuxiliaryModelMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
  callAuxiliaryModelMock: vi.fn(),
}));

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

vi.mock('../src/providers/auxiliary.js', () => ({
  callAuxiliaryModel: callAuxiliaryModelMock,
}));

const ORIGINAL_HOME = process.env.HOME;

const makeTempHome = useTempDir('hybridclaw-concierge-home-');

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function createFixture() {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'agent result',
    toolsUsed: [],
    toolExecutions: [],
  });

  const { initDatabase, updateSessionModel } = await import(
    '../src/memory/db.ts'
  );
  initDatabase({ quiet: true });

  const { upsertRegisteredAgent } = await import(
    '../src/agents/agent-registry.ts'
  );
  const { updateRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  const { memoryService } = await import('../src/memory/memory-service.ts');
  updateRuntimeConfig((draft) => {
    draft.local.backends.lmstudio.enabled = true;
    draft.routing.enabled = true;
    draft.routing.mode = 'speed';
    draft.routing.defaultStart = 'small';
    draft.routing.tiers = [{name:'small',models:['lmstudio/test-small']},{name:'large',models:['lmstudio/test-large']}];
    draft.routing.concierge.model = 'lmstudio/test-classifier';
    draft.plugins.list = [
      {
        id: 'concierge-router',
        enabled: true,
        path: './plugins/concierge-router',
        config: {},
      },
    ];
  });

  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );
  return {
    handleGatewayMessage,
    memoryService,
    updateRuntimeConfig,
    updateSessionModel,
    upsertRegisteredAgent,
  };
}

useCleanMocks({
  restoreAllMocks: true,
  cleanup: () => {
    runAgentMock.mockReset();
    callAuxiliaryModelMock.mockReset();
    restoreEnvVar('HOME', ORIGINAL_HOME);
  },
  resetModules: true,
});


test('one concierge chooses a configured tier without a separate urgency exchange', async () => {
 const fixture = await createFixture();
 callAuxiliaryModelMock.mockResolvedValue({model:'lmstudio/test-classifier',content:'{"capability":"advanced","urgency":"urgent","sensitive":false}'});
 const result = await fixture.handleGatewayMessage({sessionId:'unified-test',guildId:null,channelId:'tui',userId:'user-a',username:'user',content:'Explain a complex public scientific topic.',chatbotId:'bot_test'});
 expect(result.status).toBe('success');
 expect(runAgentMock.mock.calls.at(-1)?.[0].model).toBe('lmstudio/test-large');
});
test('privacy rejects an explicit cloud pin before any agent call', async () => {
 const fixture = await createFixture();
 fixture.updateRuntimeConfig(draft => {draft.routing.mode='privacy';});
 const result = await fixture.handleGatewayMessage({sessionId:'privacy-pin',guildId:null,channelId:'tui',userId:'user-a',username:'user',content:'Public question',model:'hybridai/gpt-5',chatbotId:'bot_test'});
 expect(result.status).toBe('error');
 expect(runAgentMock).not.toHaveBeenCalled();
 expect(callAuxiliaryModelMock).not.toHaveBeenCalled();
});
