import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import {
  deleteMcpServer,
  fetchMcp,
  fetchMcpOAuthStatus,
  logoutMcpOAuth,
  saveMcpServer,
  startMcpOAuth,
} from '../api/client';
import type {
  AdminMcpAuthStatus,
  AdminMcpConfig,
  AdminMcpServer,
} from '../api/types';
import { useAuth } from '../auth';
import { Button } from '../components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/card';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from '../components/field';
import { Input } from '../components/input';
import { NativeSelect, NativeSelectOption } from '../components/native-select';
import { Switch } from '../components/switch';
import { Textarea } from '../components/textarea';
import { useToast } from '../components/toast';
import { BooleanPill, PageHeader } from '../components/ui';
import { getErrorMessage } from '../lib/error-message';

type McpAuthMode = 'none' | 'headers' | 'oauth';

interface McpDraft {
  originalName: string | null;
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  enabled: boolean;
  command: string;
  args: string;
  cwd: string;
  url: string;
  envJson: string;
  authMode: McpAuthMode;
  headersJson: string;
}

const OAUTH_POLL_INTERVAL_MS = 2_000;
const OAUTH_POLL_TIMEOUT_MS = 3 * 60_000;

function formatJson(value: Record<string, string> | undefined): string {
  if (!value || Object.keys(value).length === 0) return '';
  return JSON.stringify(value, null, 2);
}

function deriveAuthMode(config?: AdminMcpConfig): McpAuthMode {
  if (config?.auth === 'oauth') return 'oauth';
  if (config?.headers && Object.keys(config.headers).length > 0) {
    return 'headers';
  }
  return 'none';
}

function createDraft(source?: AdminMcpServer): McpDraft {
  return {
    originalName: source?.name || null,
    name: source?.name || '',
    transport: source?.config.transport || 'http',
    enabled: source?.enabled ?? true,
    command: source?.config.command || '',
    args: (source?.config.args || []).join('\n'),
    cwd: source?.config.cwd || '',
    url: source?.config.url || '',
    envJson: formatJson(source?.config.env),
    authMode: source ? deriveAuthMode(source.config) : 'oauth',
    headersJson: formatJson(source?.config.headers),
  };
}

function parseJsonMap(
  value: string,
  fieldName: string,
): Record<string, string> | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(
      `${fieldName}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${fieldName} must be a JSON object.`);
  }
  return Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>)
      .map(([key, entry]) => [key, String(entry ?? '')])
      .filter(([key]) => key.trim()),
  );
}

function normalizeDraft(draft: McpDraft): {
  name: string;
  config: AdminMcpConfig;
} {
  return {
    name: draft.name.trim(),
    config: {
      transport: draft.transport,
      ...(draft.enabled ? {} : { enabled: false }),
      ...(draft.transport === 'stdio'
        ? {
            command: draft.command.trim(),
            args: draft.args
              .split('\n')
              .map((item) => item.trim())
              .filter(Boolean),
            ...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}),
            ...(draft.envJson.trim()
              ? { env: parseJsonMap(draft.envJson, 'Environment JSON') }
              : {}),
          }
        : {
            url: draft.url.trim(),
            ...(draft.authMode === 'oauth' ? { auth: 'oauth' as const } : {}),
            ...(draft.authMode === 'headers' && draft.headersJson.trim()
              ? { headers: parseJsonMap(draft.headersJson, 'Headers JSON') }
              : {}),
          }),
    },
  };
}

function describeAuthStatus(auth: AdminMcpAuthStatus): {
  label: string;
  connected: boolean;
} {
  if (auth.state === 'connected')
    return { label: 'connected', connected: true };
  if (auth.state === 'expired') return { label: 'expired', connected: false };
  return { label: 'login required', connected: false };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function McpPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [draft, setDraft] = useState<McpDraft>(createDraft());
  const [pendingAuthUrl, setPendingAuthUrl] = useState<string | null>(null);
  const connectCancelled = useRef(false);

  const mcpQuery = useQuery({
    queryKey: ['mcp', auth.token],
    queryFn: () => fetchMcp(auth.token),
  });

  const saveMutation = useMutation({
    mutationFn: () => saveMcpServer(auth.token, normalizeDraft(draft)),
    onSuccess: (payload) => {
      queryClient.setQueryData(['mcp', auth.token], payload);
      setSelectedName(draft.name.trim());
      const selected = payload.servers.find(
        (entry) => entry.name === draft.name.trim(),
      );
      setDraft(createDraft(selected));
      toast.success(`Saved MCP server ${draft.name.trim()}.`);
    },
    onError: (error) => {
      toast.error('Save failed', getErrorMessage(error));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteMcpServer(auth.token, draft.name.trim()),
    onSuccess: (payload) => {
      queryClient.setQueryData(['mcp', auth.token], payload);
      setSelectedName(null);
      setDraft(createDraft());
      toast.success('MCP server deleted.');
    },
    onError: (error) => {
      toast.error('Delete failed', getErrorMessage(error));
    },
  });

  const connectMutation = useMutation({
    mutationFn: async () => {
      connectCancelled.current = false;
      const payload = normalizeDraft(draft);
      const saved = await saveMcpServer(auth.token, payload);
      queryClient.setQueryData(['mcp', auth.token], saved);

      const started = await startMcpOAuth(auth.token, payload.name);
      setPendingAuthUrl(started.authorizationUrl);
      window.open(started.authorizationUrl, '_blank', 'noopener');

      const deadline =
        Date.now() +
        Math.max(
          OAUTH_POLL_INTERVAL_MS,
          Math.min(OAUTH_POLL_TIMEOUT_MS, started.expiresAt - Date.now()),
        );
      while (Date.now() < deadline) {
        if (connectCancelled.current) {
          throw new Error('Authorization cancelled.');
        }
        await sleep(OAUTH_POLL_INTERVAL_MS);
        const status = await fetchMcpOAuthStatus(auth.token, payload.name);
        if (status.auth.state === 'connected') return payload.name;
      }
      throw new Error(
        'Timed out waiting for authorization. Complete the login in the opened tab and try again.',
      );
    },
    onSuccess: async (name) => {
      setPendingAuthUrl(null);
      await queryClient.invalidateQueries({ queryKey: ['mcp', auth.token] });
      setSelectedName(name);
      toast.success(`Connected to ${name} via OAuth.`);
    },
    onError: (error) => {
      setPendingAuthUrl(null);
      toast.error('OAuth connection failed', getErrorMessage(error));
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: () => logoutMcpOAuth(auth.token, draft.name.trim()),
    onSuccess: (payload) => {
      queryClient.setQueryData(['mcp', auth.token], payload);
      toast.success('OAuth credentials cleared.');
    },
    onError: (error) => {
      toast.error('Disconnect failed', getErrorMessage(error));
    },
  });

  const selectedServer =
    mcpQuery.data?.servers.find((entry) => entry.name === selectedName) || null;

  useEffect(() => {
    if (selectedServer) {
      setDraft(createDraft(selectedServer));
      return;
    }
    if (!selectedName) {
      setDraft(createDraft());
    }
  }, [selectedName, selectedServer]);

  useEffect(() => {
    return () => {
      connectCancelled.current = true;
    };
  }, []);

  const authStatus = selectedServer?.auth;
  const oauthConnected = authStatus?.state === 'connected';

  return (
    <div className="page-stack">
      <PageHeader
        actions={
          <Button
            variant="ghost"
            type="button"
            onClick={() => {
              setSelectedName(null);
              setDraft(createDraft());
            }}
          >
            New server
          </Button>
        }
      />

      <div className="two-column-grid">
        <Card>
          <CardHeader>
            <CardTitle>Servers</CardTitle>
            <CardDescription>
              {`${mcpQuery.data?.servers.length || 0} configured server${mcpQuery.data?.servers.length === 1 ? '' : 's'}`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {mcpQuery.isLoading ? (
              <div className="empty-state">Loading MCP servers...</div>
            ) : mcpQuery.data?.servers.length ? (
              <div className="list-stack selectable-list">
                {mcpQuery.data.servers.map((server) => {
                  const serverAuth =
                    server.auth.method === 'oauth'
                      ? describeAuthStatus(server.auth)
                      : null;
                  return (
                    <button
                      key={server.name}
                      className={
                        server.name === selectedName
                          ? 'selectable-row active'
                          : 'selectable-row'
                      }
                      type="button"
                      onClick={() => setSelectedName(server.name)}
                    >
                      <div>
                        <strong>{server.name}</strong>
                        <small>
                          {server.summary.startsWith(`${server.name} — `)
                            ? server.summary.slice(server.name.length + 3)
                            : server.summary}
                        </small>
                      </div>
                      <div className="button-row">
                        {serverAuth ? (
                          <BooleanPill
                            value={serverAuth.connected}
                            trueLabel="oauth"
                            falseLabel={serverAuth.label}
                            falseTone="danger"
                          />
                        ) : null}
                        <BooleanPill
                          value={server.enabled}
                          trueLabel="active"
                          falseLabel="inactive"
                        />
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="empty-state">
                No MCP servers are configured yet. Add a remote server with its
                URL and connect it with OAuth, or run a local stdio command.
              </div>
            )}
          </CardContent>
        </Card>

        <Card variant="muted">
          <CardHeader>
            <CardTitle>
              {selectedServer ? `Edit ${selectedServer.name}` : 'New server'}
            </CardTitle>
            <CardDescription>
              Changes apply on the next agent turn.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="stack-form">
              <div className="field-grid">
                <Field>
                  <FieldLabel>Name</FieldLabel>
                  <Input
                    value={draft.name}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        name: event.target.value,
                      }))
                    }
                    placeholder="github"
                  />
                  <FieldDescription>
                    Lowercase letters, numbers, - and _. Used as the tool
                    prefix.
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel>Transport</FieldLabel>
                  <NativeSelect
                    value={draft.transport}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        transport: event.target.value as McpDraft['transport'],
                      }))
                    }
                  >
                    <NativeSelectOption value="http">
                      http — remote server
                    </NativeSelectOption>
                    <NativeSelectOption value="sse">
                      sse — remote server (legacy)
                    </NativeSelectOption>
                    <NativeSelectOption value="stdio">
                      stdio — local command
                    </NativeSelectOption>
                  </NativeSelect>
                </Field>
              </div>

              <Field orientation="horizontal">
                <Switch
                  checked={draft.enabled}
                  onCheckedChange={(enabled) =>
                    setDraft((current) => ({ ...current, enabled }))
                  }
                />
                <FieldContent>
                  <FieldLabel>Server state</FieldLabel>
                </FieldContent>
              </Field>

              {draft.transport === 'stdio' ? (
                <>
                  <Field>
                    <FieldLabel>Command</FieldLabel>
                    <Input
                      value={draft.command}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          command: event.target.value,
                        }))
                      }
                      placeholder="docker"
                    />
                  </Field>
                  <div className="field-grid">
                    <Field>
                      <FieldLabel>Arguments</FieldLabel>
                      <Textarea
                        rows={4}
                        value={draft.args}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            args: event.target.value,
                          }))
                        }
                        placeholder="One argument per line"
                      />
                    </Field>
                    <Field>
                      <FieldLabel>Working directory</FieldLabel>
                      <Input
                        value={draft.cwd}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            cwd: event.target.value,
                          }))
                        }
                        placeholder="/workspace"
                      />
                    </Field>
                  </div>
                  <Field>
                    <FieldLabel>Environment JSON</FieldLabel>
                    <Textarea
                      rows={5}
                      value={draft.envJson}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          envJson: event.target.value,
                        }))
                      }
                      placeholder='{"GITHUB_TOKEN":"..."}'
                    />
                  </Field>
                </>
              ) : (
                <>
                  <Field>
                    <FieldLabel>URL</FieldLabel>
                    <Input
                      value={draft.url}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          url: event.target.value,
                        }))
                      }
                      placeholder="https://mcp.example.com/mcp"
                    />
                  </Field>
                  <Field>
                    <FieldLabel>Authentication</FieldLabel>
                    <NativeSelect
                      value={draft.authMode}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          authMode: event.target.value as McpAuthMode,
                        }))
                      }
                    >
                      <NativeSelectOption value="oauth">
                        OAuth — log in via browser
                      </NativeSelectOption>
                      <NativeSelectOption value="headers">
                        Custom headers (API key / bearer token)
                      </NativeSelectOption>
                      <NativeSelectOption value="none">None</NativeSelectOption>
                    </NativeSelect>
                    <FieldDescription>
                      {draft.authMode === 'oauth'
                        ? 'The gateway discovers the authorization server, registers a client, and refreshes tokens automatically.'
                        : draft.authMode === 'headers'
                          ? 'Headers are sent with every request to the server.'
                          : 'Requests are sent without credentials.'}
                    </FieldDescription>
                  </Field>

                  {draft.authMode === 'headers' ? (
                    <Field>
                      <FieldLabel>Headers JSON</FieldLabel>
                      <Textarea
                        rows={5}
                        value={draft.headersJson}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            headersJson: event.target.value,
                          }))
                        }
                        placeholder='{"Authorization":"Bearer ..."}'
                      />
                    </Field>
                  ) : null}

                  {draft.authMode === 'oauth' ? (
                    <Field orientation="horizontal">
                      <FieldContent>
                        <FieldLabel>OAuth connection</FieldLabel>
                        <FieldDescription>
                          {connectMutation.isPending
                            ? 'Waiting for you to approve access in the browser...'
                            : oauthConnected
                              ? 'Connected. Tokens refresh automatically.'
                              : authStatus?.state === 'expired'
                                ? 'The session expired. Reconnect to continue.'
                                : 'Not connected yet. Saving happens automatically when you connect.'}
                          {pendingAuthUrl && connectMutation.isPending ? (
                            <>
                              {' '}
                              <a
                                href={pendingAuthUrl}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Open the login page
                              </a>{' '}
                              if it did not open automatically.
                            </>
                          ) : null}
                        </FieldDescription>
                      </FieldContent>
                      <div className="button-row">
                        <Button
                          type="button"
                          loading={connectMutation.isPending}
                          disabled={
                            connectMutation.isPending ||
                            !draft.name.trim() ||
                            !draft.url.trim()
                          }
                          onClick={() => connectMutation.mutate()}
                        >
                          {connectMutation.isPending
                            ? 'Waiting...'
                            : oauthConnected
                              ? 'Reconnect'
                              : 'Connect'}
                        </Button>
                        {oauthConnected ? (
                          <Button
                            variant="ghost"
                            type="button"
                            loading={disconnectMutation.isPending}
                            disabled={disconnectMutation.isPending}
                            onClick={() => disconnectMutation.mutate()}
                          >
                            Disconnect
                          </Button>
                        ) : null}
                      </div>
                    </Field>
                  ) : null}
                </>
              )}

              <div className="button-row">
                <Button
                  type="button"
                  loading={saveMutation.isPending}
                  disabled={saveMutation.isPending}
                  onClick={() => saveMutation.mutate()}
                >
                  {saveMutation.isPending ? 'Saving...' : 'Save server'}
                </Button>
                {selectedServer ? (
                  <Button
                    variant="danger"
                    type="button"
                    loading={deleteMutation.isPending}
                    disabled={deleteMutation.isPending}
                    onClick={() => deleteMutation.mutate()}
                  >
                    {deleteMutation.isPending ? 'Deleting...' : 'Delete server'}
                  </Button>
                ) : null}
              </div>

              {selectedServer ? (
                <div className="summary-block">
                  <span>Summary</span>
                  <p>{selectedServer.summary}</p>
                </div>
              ) : null}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
