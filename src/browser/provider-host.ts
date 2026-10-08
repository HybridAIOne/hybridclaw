/**
 * Browser provider host — the gateway capabilities a plugin-supplied browser
 * provider is handed in `create(host)`. Plugins never import core modules, so
 * navigation guards, secret handles, audit, usage metering, and the shared
 * Playwright session come through here as values: a vendor provider reuses
 * the core checks instead of carrying its own copy.
 *
 * NOT the registry (`provider-factory.ts` maps a kind to its plugin) and not
 * a sandbox: providers run in the gateway process as trusted plugin code.
 */
import { assertBrowserNavigationUrl } from '../../container/shared/browser-navigation.js';
import { DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import {
  assertSecretResolveAllowed,
  recordSecretResolved,
  recordSecretUnsafeEscaped,
} from '../gateway/gateway-secret-injection.js';
import { agentWorkspaceDir } from '../infra/ipc.js';
import { recordUsageEvent } from '../memory/db.js';
import { assertBrowserStealthAllowed } from '../security/browser-stealth-policy.js';
import {
  isSecretHandle,
  type SecretHandle,
  unsafeEscapeSecretHandle,
} from '../security/secret-handles.js';
import { hardenSecretRef } from '../security/secret-refs.js';
import {
  fillBrowserField,
  loadPlaywrightModule,
  noopSecretAudit,
  normalizeScrollDelta,
  PlaywrightBrowserSession,
  toNavigationOptions,
} from './playwright-utils.js';
import {
  resolveBrowserProfileRoot,
  resolveConstrainedBrowserProfileDir,
} from './profile-dir.js';
import {
  type BrowserProviderCapabilities,
  DEFAULT_BROWSER_PROVIDER_CAPABILITIES,
} from './provider.js';

export interface BrowserProviderHost {
  /** `browser.allowPrivateNetwork`; pass it to `navigation.assertUrl`. */
  allowPrivateNetwork: boolean;
  secretAudit: (handle: SecretHandle, reason: string) => void;
  capabilities: BrowserProviderCapabilities;
  navigation: { assertUrl: typeof assertBrowserNavigationUrl };
  playwright: {
    load<T>(errorMessage: (cause: string) => string): Promise<T>;
    BrowserSession: typeof PlaywrightBrowserSession;
    toNavigationOptions: typeof toNavigationOptions;
    fillField: typeof fillBrowserField;
    normalizeScrollDelta: typeof normalizeScrollDelta;
  };
  profiles: {
    resolveRoot: typeof resolveBrowserProfileRoot;
    resolveDir: typeof resolveConstrainedBrowserProfileDir;
  };
  audit: { record: typeof recordAuditEvent; makeRunId: typeof makeAuditRunId };
  usage: { record: typeof recordUsageEvent };
  /** Form fills that bypass `playwright.fillField` (native drivers). */
  secrets: {
    hardenRef: typeof hardenSecretRef;
    isHandle: typeof isSecretHandle;
    unsafeEscape: typeof unsafeEscapeSecretHandle;
    assertResolveAllowed: typeof assertSecretResolveAllowed;
    recordResolved: typeof recordSecretResolved;
    recordUnsafeEscaped: typeof recordSecretUnsafeEscaped;
  };
  /** The agent's workspace `browser.stealth` rules decide each host. */
  stealth: {
    assertAllowed(context: {
      host: string;
      agentId?: string;
      skillName?: string;
    }): void;
  };
  /** The gateway's MCP SDK, for drivers that speak MCP over stdio. */
  mcp: {
    load(): Promise<{
      Client: typeof import('@modelcontextprotocol/sdk/client/index.js').Client;
      StdioClientTransport: typeof import('@modelcontextprotocol/sdk/client/stdio.js').StdioClientTransport;
      getDefaultEnvironment: typeof import('@modelcontextprotocol/sdk/client/stdio.js').getDefaultEnvironment;
      CallToolResultSchema: typeof import('@modelcontextprotocol/sdk/types.js').CallToolResultSchema;
    }>;
  };
}

export function createBrowserProviderHost(params: {
  allowPrivateNetwork: boolean;
  secretAudit?: (handle: SecretHandle, reason: string) => void;
}): BrowserProviderHost {
  return {
    allowPrivateNetwork: params.allowPrivateNetwork,
    secretAudit: params.secretAudit || noopSecretAudit,
    capabilities: DEFAULT_BROWSER_PROVIDER_CAPABILITIES,
    navigation: { assertUrl: assertBrowserNavigationUrl },
    playwright: {
      load: <T>(errorMessage: (cause: string) => string) =>
        loadPlaywrightModule<T>(undefined, errorMessage),
      BrowserSession: PlaywrightBrowserSession,
      toNavigationOptions,
      fillField: fillBrowserField,
      normalizeScrollDelta,
    },
    profiles: {
      resolveRoot: resolveBrowserProfileRoot,
      resolveDir: resolveConstrainedBrowserProfileDir,
    },
    audit: { record: recordAuditEvent, makeRunId: makeAuditRunId },
    usage: { record: recordUsageEvent },
    secrets: {
      hardenRef: hardenSecretRef,
      isHandle: isSecretHandle,
      unsafeEscape: unsafeEscapeSecretHandle,
      assertResolveAllowed: assertSecretResolveAllowed,
      recordResolved: recordSecretResolved,
      recordUnsafeEscaped: recordSecretUnsafeEscaped,
    },
    stealth: {
      assertAllowed({ host, agentId, skillName }) {
        const agent = agentId?.trim() || DEFAULT_AGENT_ID;
        assertBrowserStealthAllowed({
          workspacePath: agentWorkspaceDir(agent),
          context: { host, agentId: agent, skillName },
        });
      },
    },
    mcp: {
      async load() {
        const [client, stdio, types] = await Promise.all([
          import('@modelcontextprotocol/sdk/client/index.js'),
          import('@modelcontextprotocol/sdk/client/stdio.js'),
          import('@modelcontextprotocol/sdk/types.js'),
        ]);
        return {
          Client: client.Client,
          StdioClientTransport: stdio.StdioClientTransport,
          getDefaultEnvironment: stdio.getDefaultEnvironment,
          CallToolResultSchema: types.CallToolResultSchema,
        };
      },
    },
  };
}
