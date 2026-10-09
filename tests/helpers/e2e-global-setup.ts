/**
 * Vitest globalSetup for e2e tests. Prints guidance when env vars are
 * missing so developers know how to enable specific test suites.
 */
export function setup(): void {
  const dockerE2e = process.env.HYBRIDCLAW_RUN_DOCKER_E2E === '1';
  const hasGatewayImage = !!process.env.HYBRIDCLAW_E2E_IMAGE;
  const hasAgentImage = !!process.env.HYBRIDCLAW_E2E_AGENT_IMAGE;
  const npmE2e = process.env.HYBRIDCLAW_RUN_NPM_E2E === '1';
  const consoleE2e = process.env.HYBRIDCLAW_RUN_CONSOLE_E2E === '1';
  const msteamsE2e = process.env.HYBRIDCLAW_RUN_MSTEAMS_E2E === '1';

  const skipped: string[] = [];

  if (!dockerE2e || !hasGatewayImage) {
    skipped.push(
      '  HYBRIDCLAW_RUN_DOCKER_E2E=1  HYBRIDCLAW_E2E_IMAGE=<tag>        \u2192 gateway tests',
    );
  }
  if (!dockerE2e || !hasAgentImage) {
    skipped.push(
      '  HYBRIDCLAW_RUN_DOCKER_E2E=1  HYBRIDCLAW_E2E_AGENT_IMAGE=<tag>  \u2192 agent tests',
    );
  }
  if (!npmE2e) {
    skipped.push(
      '  HYBRIDCLAW_RUN_NPM_E2E=1                                        \u2192 npm install journey',
    );
  }
  if (!consoleE2e) {
    skipped.push(
      '  HYBRIDCLAW_RUN_CONSOLE_E2E=1                                    \u2192 admin console in a browser',
    );
  }
  if (process.env.HYBRIDCLAW_RUN_BROWSER_PLUGIN_E2E !== '1') {
    skipped.push(
      '  HYBRIDCLAW_RUN_BROWSER_PLUGIN_E2E=1                             \u2192 browser provider plugins',
    );
  }

  if (!msteamsE2e) {
    skipped.push(
      '  HYBRIDCLAW_RUN_MSTEAMS_E2E=1                                    \u2192 Teams webhook against a built gateway',
    );
  }

  if (skipped.length > 0) {
    console.log(
      `\nE2E tests skipped (set env vars to enable):\n${skipped.join('\n')}\n`,
    );
  }
}
