import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import type {
  GatewayAgentsResponse,
  GatewayLogicalAgentCard,
  GatewaySessionCard,
} from '../src/gateway/gateway-types.ts';

const docsHtml = fs.readFileSync(
  path.join(process.cwd(), 'docs', 'agents.html'),
  'utf8',
);

const responseFields = [
  'agents',
  'sessions',
  'generatedAt',
  'version',
  'totals',
] as const satisfies ReadonlyArray<keyof GatewayAgentsResponse>;

const logicalAgentFields = [
  'activeSessions',
  'chatbotId',
  'costUsd',
  'effectiveModels',
  'enableRag',
  'id',
  'idleSessions',
  'inputTokens',
  'lastActive',
  'messageCount',
  'model',
  'name',
  'outputTokens',
  'recentSessionId',
  'sessionCount',
  'status',
  'stoppedSessions',
  'toolCalls',
  'workspacePath',
] as const satisfies ReadonlyArray<keyof GatewayLogicalAgentCard>;

const sessionFields = [
  'agentId',
  'channelId',
  'channelName',
  'costUsd',
  'fullAutoEnabled',
  'id',
  'inputTokens',
  'lastActive',
  'lastAnswer',
  'lastQuestion',
  'messageCount',
  'model',
  'name',
  'output',
  'outputTokens',
  'previewMeta',
  'previewTitle',
  'runtimeMinutes',
  'sessionId',
  'status',
  'task',
  'toolCalls',
  'watcher',
] as const satisfies ReadonlyArray<keyof GatewaySessionCard>;

function referencesField(field: string): boolean {
  const pattern = new RegExp(`\\.[\\s]*${field}\\b`);
  return pattern.test(docsHtml);
}

describe('docs/agents.html contract', () => {
  test('fetches the gateway agents response shape', () => {
    for (const field of responseFields) {
      expect(docsHtml).toContain(`payload.${field}`);
    }
  });

  test('renders the logical agent fields it depends on', () => {
    for (const field of logicalAgentFields) {
      expect(referencesField(field)).toBe(true);
    }
  });

  test('renders the session fields it depends on', () => {
    for (const field of sessionFields) {
      expect(referencesField(field)).toBe(true);
    }
  });

  test('keeps local web-surface navigation on the token-ready path', () => {
    expect(docsHtml).toContain(
      "const LOCAL_TOKEN_BOOTSTRAP_PARAM = '__hybridclaw_token_bootstrapped';",
    );
    expect(docsHtml).toContain('function navigateLocalWebSurface(path)');
    expect(docsHtml).toContain(
      "document.addEventListener('click', handleLocalWebSurfaceClick);",
    );
    expect(docsHtml).not.toContain("window.location.assign('/chat')");
    expect(docsHtml).not.toContain("window.location.assign('/admin");
  });
});
