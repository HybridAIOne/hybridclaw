/**
 * Bundles the gateway entry points `task-runner.mjs` calls into
 * dist/harbor-adapter-api.js, so the packed npm tarball carries them.
 * Run from the repo root after `npm run build`.
 */
import { build } from 'esbuild';

await build({
  stdin: {
    contents: `
      export { getRuntimeConfig } from './src/config/runtime-config.ts';
      export { resolveModelProvider } from './src/providers/factory.ts';
      export { initDatabase } from './src/memory/database.ts';
      export { initAgentRegistry } from './src/agents/agent-registry.ts';
      export { handleGatewayMessage } from './src/gateway/gateway-chat-service.ts';
      export { flushAuditTrail } from './src/audit/audit-trail.ts';
      export { startGatewayHttpServer } from './src/gateway/gateway-http-server.ts';
      export { GATEWAY_API_TOKEN, GATEWAY_CLIENT_BASE_URL } from './src/config/config.ts';
      export { SHELL_RUNTIME_ENV_PATH } from '@hybridclaw/shared/shell-runtime-env';
    `,
    resolveDir: process.cwd(),
    sourcefile: 'harbor-adapter-api.ts',
    loader: 'ts',
  },
  outfile: 'dist/harbor-adapter-api.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  plugins: [
    {
      // The workspace packages are not published, so they are inlined; every
      // third-party import resolves from the installed package's node_modules.
      name: 'external-third-party',
      setup(bundle) {
        bundle.onResolve({ filter: /^[^./]/ }, (args) =>
          args.path.startsWith('@hybridclaw/') ? undefined : { external: true },
        );
      },
    },
  ],
  logLevel: 'warning',
});
