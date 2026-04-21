import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  buildAnthropicSupportingHeaders,
  isAnthropicOAuthToken,
} from '../providers/anthropic-utils.js';
import {
  readStoredRuntimeSecret,
  runtimeSecretsPath,
} from '../security/runtime-secrets.js';
import type { AnthropicMethod } from '../types/models.js';

const CLAUDE_CLI_CREDENTIALS_RELATIVE_PATH = '.claude/.credentials.json';
const CLAUDE_CLI_KEYCHAIN_SERVICE = 'Claude Code-credentials';
const CLAUDE_CLI_CREDENTIAL_CACHE_MAX_TTL_MS = 60_000;
const CLAUDE_CLI_CREDENTIAL_CACHE_EXPIRY_SKEW_MS = 5_000;

type CliSource = 'claude-cli-keychain' | 'claude-cli-file';
type ApiKeySource = 'env' | 'runtime-secrets';

export type ClaudeCliCredential =
  | {
      type: 'oauth';
      provider: 'anthropic';
      accessToken: string;
      refreshToken: string;
      expiresAt: number;
      source: CliSource;
    }
  | {
      type: 'token';
      provider: 'anthropic';
      token: string;
      expiresAt: number;
      source: CliSource;
    };

export interface AnthropicResolvedAuth {
  method: 'api-key';
  source: ApiKeySource;
  apiKey: string;
  headers: Record<string, string>;
  path: string;
}

export interface AnthropicAuthStatus {
  authenticated: boolean;
  method: AnthropicMethod | null;
  source: ApiKeySource | CliSource | null;
  path: string;
  maskedValue: string | null;
  expiresAt: number | null;
  isOauthToken: boolean;
}

let cachedClaudeCliCredential: {
  credential: ClaudeCliCredential;
  cacheUntilMs: number;
} | null = null;

export function claudeCliCredentialsPath(): string {
  return path.join(homedir(), CLAUDE_CLI_CREDENTIALS_RELATIVE_PATH);
}

export function claudeCliKeychainLabel(): string {
  return `macOS Keychain (${CLAUDE_CLI_KEYCHAIN_SERVICE})`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function maskValue(value: string): string {
  const normalized = value.trim();
  if (!normalized) return '';
  if (normalized.length <= 12) return `${normalized.slice(0, 4)}...`;
  return `${normalized.slice(0, 6)}...${normalized.slice(-4)}`;
}

function parseClaudeCliCredential(
  value: unknown,
  source: CliSource,
): ClaudeCliCredential | null {
  if (!isRecord(value)) return null;
  const accessToken = normalizeString(value.accessToken);
  const refreshToken = normalizeString(value.refreshToken);
  const expiresAt =
    typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt)
      ? value.expiresAt
      : 0;
  if (!accessToken || expiresAt <= 0) return null;
  if (refreshToken) {
    return {
      type: 'oauth',
      provider: 'anthropic',
      accessToken,
      refreshToken,
      expiresAt,
      source,
    };
  }
  return {
    type: 'token',
    provider: 'anthropic',
    token: accessToken,
    expiresAt,
    source,
  };
}

function readClaudeCliKeychainCredentials(): ClaudeCliCredential | null {
  if (process.platform !== 'darwin') return null;
  try {
    const raw = execFileSync(
      'security',
      ['find-generic-password', '-s', CLAUDE_CLI_KEYCHAIN_SERVICE, '-w'],
      {
        encoding: 'utf8',
        timeout: 5_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    ).trim();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parseClaudeCliCredential(
      parsed.claudeAiOauth,
      'claude-cli-keychain',
    );
  } catch {
    return null;
  }
}

export function readClaudeCliCredentials(): ClaudeCliCredential | null {
  const keychain = readClaudeCliKeychainCredentials();
  if (keychain) return keychain;

  try {
    const raw = JSON.parse(
      fs.readFileSync(claudeCliCredentialsPath(), 'utf-8'),
    ) as Record<string, unknown>;
    return parseClaudeCliCredential(raw.claudeAiOauth, 'claude-cli-file');
  } catch {
    return null;
  }
}

function readCachedClaudeCliCredentials(): ClaudeCliCredential | null {
  const now = Date.now();
  if (
    cachedClaudeCliCredential &&
    cachedClaudeCliCredential.cacheUntilMs > now &&
    cachedClaudeCliCredential.credential.expiresAt > now
  ) {
    return cachedClaudeCliCredential.credential;
  }
  cachedClaudeCliCredential = null;

  const credential = readClaudeCliCredentials();
  if (!credential) return null;

  const cacheUntilMs = Math.min(
    now + CLAUDE_CLI_CREDENTIAL_CACHE_MAX_TTL_MS,
    credential.expiresAt - CLAUDE_CLI_CREDENTIAL_CACHE_EXPIRY_SKEW_MS,
  );
  if (cacheUntilMs > now) {
    cachedClaudeCliCredential = {
      credential,
      cacheUntilMs,
    };
  }
  return credential;
}

function resolveStoredAnthropicApiKey(): {
  apiKey: string;
  source: ApiKeySource | null;
} {
  const envApiKey = process.env.ANTHROPIC_API_KEY?.trim() || '';
  const storedApiKey = readStoredRuntimeSecret('ANTHROPIC_API_KEY') || '';
  if (envApiKey) {
    return {
      apiKey: envApiKey,
      source:
        storedApiKey && storedApiKey === envApiKey ? 'runtime-secrets' : 'env',
    };
  }
  if (storedApiKey) {
    return {
      apiKey: storedApiKey,
      source: 'runtime-secrets',
    };
  }
  return {
    apiKey: '',
    source: null,
  };
}

export function getAnthropicAuthStatus(): AnthropicAuthStatus {
  const storedApiKey = resolveStoredAnthropicApiKey();
  if (storedApiKey.apiKey) {
    return {
      authenticated: true,
      method: 'api-key',
      source: storedApiKey.source,
      path: runtimeSecretsPath(),
      maskedValue: maskValue(storedApiKey.apiKey),
      expiresAt: null,
      isOauthToken: isAnthropicOAuthToken(storedApiKey.apiKey),
    };
  }

  const credential = readClaudeCliCredentials();
  const expiresAt = credential?.expiresAt ?? null;
  const authenticated =
    Boolean(credential) &&
    Boolean(expiresAt && Number.isFinite(expiresAt) && expiresAt > Date.now());
  const token =
    credential?.type === 'oauth'
      ? credential.accessToken
      : credential?.token || '';

  return {
    authenticated,
    method: credential ? 'claude-cli' : null,
    source: credential?.source || null,
    path:
      credential?.source === 'claude-cli-keychain'
        ? claudeCliKeychainLabel()
        : claudeCliCredentialsPath(),
    maskedValue: token ? maskValue(token) : null,
    expiresAt,
    isOauthToken: token ? isAnthropicOAuthToken(token) : false,
  };
}

export function isAnthropicAuthReadyForMethod(
  status: AnthropicAuthStatus,
  method: AnthropicMethod,
): boolean {
  if (method === 'claude-cli') {
    return (
      status.method === 'claude-cli' &&
      status.authenticated === true &&
      (status.expiresAt == null || status.expiresAt > Date.now())
    );
  }
  return status.method === 'api-key' && status.authenticated === true;
}

export function requireAnthropicClaudeCliCredential(): ClaudeCliCredential {
  const credential = readCachedClaudeCliCredentials();
  if (!credential) {
    throw new Error(
      [
        'Claude CLI is not authenticated on this host.',
        'Run `claude auth login`, then rerun `hybridclaw auth login anthropic --method claude-cli --set-default`.',
      ].join('\n'),
    );
  }
  if (credential.expiresAt <= Date.now()) {
    throw new Error(
      [
        'Claude CLI credentials on this host are expired.',
        'Run `claude auth login` to refresh them, then rerun the HybridClaw Anthropic auth command.',
      ].join('\n'),
    );
  }
  return credential;
}

export function requireAnthropicApiKey(): AnthropicResolvedAuth {
  const storedApiKey = resolveStoredAnthropicApiKey();
  if (storedApiKey.apiKey) {
    return {
      method: 'api-key',
      source: storedApiKey.source || 'runtime-secrets',
      apiKey: storedApiKey.apiKey,
      headers: buildAnthropicSupportingHeaders({ apiKey: storedApiKey.apiKey }),
      path: runtimeSecretsPath(),
    };
  }
  throw new Error(
    [
      `ANTHROPIC_API_KEY is missing from your shell and ${runtimeSecretsPath()}.`,
      'Run `hybridclaw auth login anthropic --method api-key --set-default` to configure the direct Anthropic API provider.',
    ].join('\n'),
  );
}
