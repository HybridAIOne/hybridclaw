/**
 * Interactive TUI wizard for adding/editing MCP servers and running the
 * gateway-managed OAuth login flow, so users never have to hand-write the
 * JSON payload that `/mcp add <name> <json>` expects.
 */
import type readline from 'node:readline';

import {
  fetchGatewayMcpOAuthStatus,
  logoutGatewayMcpOAuth,
  saveGatewayAdminMcpServer,
  startGatewayMcpOAuth,
} from './gateway/gateway-client.js';
import type {
  GatewayAdminMcpOAuthStartResponse,
  GatewayAdminMcpOAuthStatusResponse,
  GatewayAdminMcpResponse,
  GatewayAdminMcpServer,
} from './gateway/gateway-types.js';
import type { McpServerConfig } from './types/models.js';
import { tryOpenUrlInBrowser } from './utils/open-url.js';

const MCP_SERVER_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const OAUTH_POLL_INTERVAL_MS = 2_000;
const OAUTH_POLL_TIMEOUT_MS = 3 * 60_000;

export interface TuiMcpWizardPalette {
  reset: string;
  bold: string;
  muted: string;
  teal: string;
  green: string;
  red: string;
}

export const DEFAULT_TUI_MCP_WIZARD_PALETTE: Readonly<TuiMcpWizardPalette> =
  Object.freeze({
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    muted: '\x1b[90m',
    teal: '\x1b[36m',
    green: '\x1b[32m',
    red: '\x1b[31m',
  });

export type TuiMcpAuthChoice = 'oauth' | 'bearer' | 'headers' | 'none';

export interface TuiMcpWizardAnswers {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  argsLine?: string;
  cwd?: string;
  envPairs?: string;
  url?: string;
  authChoice?: TuiMcpAuthChoice;
  bearerToken?: string;
  headerPairs?: string;
}

export function isValidTuiMcpServerName(name: string): boolean {
  return MCP_SERVER_NAME_RE.test(name);
}

/** Parse `KEY=VALUE` pairs separated by commas (values may contain `=`). */
export function parseTuiMcpKeyValuePairs(
  input: string,
): Record<string, string> | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  const result: Record<string, string> = {};
  for (const pair of trimmed.split(',')) {
    const entry = pair.trim();
    if (!entry) continue;
    const separator = entry.indexOf('=');
    if (separator <= 0) {
      throw new Error(
        `Expected KEY=VALUE pairs separated by commas, got: ${entry}`,
      );
    }
    result[entry.slice(0, separator).trim()] = entry
      .slice(separator + 1)
      .trim();
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function parseTuiMcpArgsLine(input: string): string[] {
  const matches = input.match(/"[^"]*"|\S+/g) ?? [];
  return matches.map((token) =>
    token.startsWith('"') && token.endsWith('"') && token.length >= 2
      ? token.slice(1, -1)
      : token,
  );
}

/** Build the gateway config payload from wizard answers. Throws on bad input. */
export function buildTuiMcpServerConfig(
  answers: TuiMcpWizardAnswers,
): McpServerConfig {
  if (answers.transport === 'stdio') {
    const command = (answers.command || '').trim();
    if (!command) throw new Error('stdio MCP servers require a command.');
    const args = parseTuiMcpArgsLine(answers.argsLine || '');
    const env = parseTuiMcpKeyValuePairs(answers.envPairs || '');
    const cwd = (answers.cwd || '').trim();
    return {
      transport: 'stdio',
      command,
      ...(args.length > 0 ? { args } : {}),
      ...(cwd ? { cwd } : {}),
      ...(env ? { env } : {}),
    };
  }

  const url = (answers.url || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('Remote MCP servers require an http(s) URL.');
  }
  const config: McpServerConfig = { transport: answers.transport, url };
  const choice = answers.authChoice || 'none';
  if (choice === 'oauth') {
    config.auth = 'oauth';
  } else if (choice === 'bearer') {
    const token = (answers.bearerToken || '').trim();
    if (!token) throw new Error('A token is required for bearer auth.');
    config.headers = { Authorization: `Bearer ${token}` };
  } else if (choice === 'headers') {
    const headers = parseTuiMcpKeyValuePairs(answers.headerPairs || '');
    if (!headers) {
      throw new Error('At least one header is required for custom headers.');
    }
    config.headers = headers;
  }
  return config;
}

export interface TuiMcpWizardDeps {
  saveServer: typeof saveGatewayAdminMcpServer;
  startOAuth: typeof startGatewayMcpOAuth;
  fetchOAuthStatus: typeof fetchGatewayMcpOAuthStatus;
  logoutOAuth: typeof logoutGatewayMcpOAuth;
  openUrl: typeof tryOpenUrlInBrowser;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const defaultDeps: TuiMcpWizardDeps = {
  saveServer: saveGatewayAdminMcpServer,
  startOAuth: startGatewayMcpOAuth,
  fetchOAuthStatus: fetchGatewayMcpOAuthStatus,
  logoutOAuth: logoutGatewayMcpOAuth,
  openUrl: tryOpenUrlInBrowser,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

function ask(rl: readline.Interface, query: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(query, resolve);
  });
}

async function askWithDefault(
  rl: readline.Interface,
  palette: TuiMcpWizardPalette,
  label: string,
  options?: { defaultValue?: string; hint?: string },
): Promise<string> {
  const hint = options?.hint
    ? ` ${palette.muted}(${options.hint})${palette.reset}`
    : '';
  const fallback = options?.defaultValue
    ? ` ${palette.muted}[${options.defaultValue}]${palette.reset}`
    : '';
  const answer = (
    await ask(
      rl,
      `  ${palette.teal}${label}${palette.reset}${hint}${fallback}: `,
    )
  ).trim();
  return answer || options?.defaultValue || '';
}

async function askChoice(
  rl: readline.Interface,
  palette: TuiMcpWizardPalette,
  label: string,
  choices: Array<{ value: string; label: string; hint?: string }>,
  defaultIndex: number,
): Promise<string> {
  console.log(`  ${palette.bold}${label}${palette.reset}`);
  choices.forEach((choice, index) => {
    const marker =
      index === defaultIndex ? `${palette.green}*${palette.reset}` : ' ';
    const hint = choice.hint
      ? ` ${palette.muted}— ${choice.hint}${palette.reset}`
      : '';
    console.log(
      `   ${marker} ${palette.teal}${index + 1}${palette.reset} ${choice.label}${hint}`,
    );
  });
  const raw = (
    await ask(
      rl,
      `  ${palette.muted}Select 1-${choices.length} (Enter for ${defaultIndex + 1}):${palette.reset} `,
    )
  ).trim();
  if (!raw) return choices[defaultIndex].value;
  const index = Number.parseInt(raw, 10);
  if (Number.isFinite(index) && index >= 1 && index <= choices.length) {
    return choices[index - 1].value;
  }
  const match = choices.find((choice) => choice.value === raw.toLowerCase());
  return match ? match.value : choices[defaultIndex].value;
}

export interface TuiMcpWizardResult {
  cancelled: boolean;
  saved?: boolean;
  name?: string;
  oauthStarted?: boolean;
  oauthConnected?: boolean;
}

/**
 * Wait for the gateway to report the server as connected after the user
 * approves access in the browser.
 */
export async function waitForTuiMcpOAuthConnection(input: {
  name: string;
  deps?: Partial<TuiMcpWizardDeps>;
  timeoutMs?: number;
}): Promise<GatewayAdminMcpOAuthStatusResponse | null> {
  const deps = { ...defaultDeps, ...input.deps };
  const deadline = deps.now() + (input.timeoutMs ?? OAUTH_POLL_TIMEOUT_MS);
  while (deps.now() < deadline) {
    await deps.sleep(OAUTH_POLL_INTERVAL_MS);
    try {
      const status = await deps.fetchOAuthStatus(input.name);
      if (status.auth.state === 'connected') return status;
    } catch {
      // Gateway may be briefly unavailable mid-poll; keep waiting.
    }
  }
  return null;
}

/**
 * Run the OAuth login flow for a configured server: request the authorization
 * URL from the gateway, open it in a browser, and poll until connected.
 */
export async function runTuiMcpOAuthLogin(input: {
  name: string;
  palette?: Partial<TuiMcpWizardPalette>;
  deps?: Partial<TuiMcpWizardDeps>;
}): Promise<boolean> {
  const palette = { ...DEFAULT_TUI_MCP_WIZARD_PALETTE, ...input.palette };
  const deps = { ...defaultDeps, ...input.deps };

  let started: GatewayAdminMcpOAuthStartResponse;
  try {
    started = await deps.startOAuth(input.name);
  } catch (error) {
    console.log(
      `  ${palette.red}OAuth login failed:${palette.reset} ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }

  const opened = await deps.openUrl(started.authorizationUrl);
  console.log('');
  console.log(
    opened
      ? `  ${palette.green}Opened your browser to authorize ${palette.bold}${input.name}${palette.reset}${palette.green}.${palette.reset}`
      : `  Open this URL in your browser to authorize ${palette.bold}${input.name}${palette.reset}:`,
  );
  console.log(`  ${palette.teal}${started.authorizationUrl}${palette.reset}`);
  console.log(`  ${palette.muted}Waiting for authorization...${palette.reset}`);

  const status = await waitForTuiMcpOAuthConnection({
    name: input.name,
    deps: input.deps,
    timeoutMs: Math.max(
      OAUTH_POLL_INTERVAL_MS,
      Math.min(OAUTH_POLL_TIMEOUT_MS, started.expiresAt - deps.now()),
    ),
  });
  if (status) {
    console.log(
      `  ${palette.green}Connected!${palette.reset} MCP server ${palette.bold}${input.name}${palette.reset} is authorized. Tools load on the next turn.`,
    );
    return true;
  }
  console.log(
    `  ${palette.red}Timed out waiting for authorization.${palette.reset} Run ${palette.teal}/mcp login ${input.name}${palette.reset} to retry.`,
  );
  return false;
}

/**
 * Guided add/edit flow. Pass `existing` to prefill answers when editing.
 */
export async function promptTuiMcpServerWizard(input: {
  rl: readline.Interface;
  existing?: GatewayAdminMcpServer | null;
  presetName?: string;
  palette?: Partial<TuiMcpWizardPalette>;
  deps?: Partial<TuiMcpWizardDeps>;
}): Promise<TuiMcpWizardResult> {
  const { rl, existing } = input;
  const palette = { ...DEFAULT_TUI_MCP_WIZARD_PALETTE, ...input.palette };
  const deps = { ...defaultDeps, ...input.deps };

  console.log('');
  console.log(
    `  ${palette.bold}${existing ? `Edit MCP server: ${existing.name}` : 'Add MCP server'}${palette.reset} ${palette.muted}(Enter to accept defaults, Ctrl+C to abort)${palette.reset}`,
  );

  const presetName = (input.presetName || '').trim();
  let name =
    existing?.name || (isValidTuiMcpServerName(presetName) ? presetName : '');
  while (!name) {
    const answer = await askWithDefault(rl, palette, 'Name', {
      hint: 'lowercase letters, numbers, - and _',
    });
    if (!answer) return { cancelled: true };
    if (!isValidTuiMcpServerName(answer)) {
      console.log(
        `  ${palette.red}Invalid name.${palette.reset} Use lowercase letters, numbers, \`-\` or \`_\`, starting with a letter or number.`,
      );
      continue;
    }
    name = answer;
  }

  const transport = (await askChoice(
    rl,
    palette,
    'Transport',
    [
      {
        value: 'http',
        label: 'http',
        hint: 'remote server (streamable HTTP)',
      },
      { value: 'sse', label: 'sse', hint: 'remote server (legacy SSE)' },
      { value: 'stdio', label: 'stdio', hint: 'local command' },
    ],
    existing?.config.transport === 'sse'
      ? 1
      : existing?.config.transport === 'stdio'
        ? 2
        : 0,
  )) as 'stdio' | 'http' | 'sse';

  const answers: TuiMcpWizardAnswers = { name, transport };

  if (transport === 'stdio') {
    answers.command = await askWithDefault(rl, palette, 'Command', {
      defaultValue: existing?.config.command || '',
    });
    answers.argsLine = await askWithDefault(rl, palette, 'Arguments', {
      hint: 'space separated, quote as needed',
      defaultValue: (existing?.config.args || []).join(' '),
    });
    answers.cwd = await askWithDefault(rl, palette, 'Working directory', {
      hint: 'optional',
      defaultValue: existing?.config.cwd || '',
    });
    answers.envPairs = await askWithDefault(rl, palette, 'Environment', {
      hint: 'optional, KEY=VALUE pairs separated by commas',
      defaultValue: Object.entries(existing?.config.env || {})
        .map(([key, value]) => `${key}=${value}`)
        .join(','),
    });
  } else {
    answers.url = await askWithDefault(rl, palette, 'Server URL', {
      hint: 'https://...',
      defaultValue: existing?.config.url || '',
    });
    const existingChoice: TuiMcpAuthChoice =
      existing?.config.auth === 'oauth'
        ? 'oauth'
        : existing?.config.headers &&
            Object.keys(existing.config.headers).length > 0
          ? 'headers'
          : 'none';
    answers.authChoice = (await askChoice(
      rl,
      palette,
      'Authentication',
      [
        {
          value: 'oauth',
          label: 'OAuth',
          hint: 'log in via browser; tokens managed automatically',
        },
        {
          value: 'bearer',
          label: 'API key / bearer token',
          hint: 'sets an Authorization header',
        },
        {
          value: 'headers',
          label: 'Custom headers',
          hint: 'KEY=VALUE pairs separated by commas',
        },
        { value: 'none', label: 'None', hint: 'no authentication' },
      ],
      existingChoice === 'headers' ? 2 : existingChoice === 'none' ? 3 : 0,
    )) as TuiMcpAuthChoice;
    if (answers.authChoice === 'bearer') {
      answers.bearerToken = await askWithDefault(rl, palette, 'Token', {
        hint: 'sent as `Authorization: Bearer <token>`',
      });
    } else if (answers.authChoice === 'headers') {
      answers.headerPairs = await askWithDefault(rl, palette, 'Headers', {
        hint: 'KEY=VALUE pairs separated by commas',
        defaultValue: Object.entries(existing?.config.headers || {})
          .map(([key, value]) => `${key}=${value}`)
          .join(','),
      });
    }
  }

  let config: McpServerConfig;
  try {
    config = buildTuiMcpServerConfig(answers);
  } catch (error) {
    console.log(
      `  ${palette.red}${error instanceof Error ? error.message : String(error)}${palette.reset}`,
    );
    return { cancelled: true };
  }
  if (existing?.config.enabled === false) config.enabled = false;

  let response: GatewayAdminMcpResponse;
  try {
    response = await deps.saveServer({ name, config });
  } catch (error) {
    console.log(
      `  ${palette.red}Save failed:${palette.reset} ${error instanceof Error ? error.message : String(error)}`,
    );
    return { cancelled: false, saved: false, name };
  }
  const saved = response.servers.find((server) => server.name === name);
  console.log(
    `  ${palette.green}Saved.${palette.reset} ${saved?.summary || name}`,
  );

  if (config.auth !== 'oauth') {
    return { cancelled: false, saved: true, name };
  }
  const connected = await runTuiMcpOAuthLogin({
    name,
    palette: input.palette,
    deps: input.deps,
  });
  return {
    cancelled: false,
    saved: true,
    name,
    oauthStarted: true,
    oauthConnected: connected,
  };
}
