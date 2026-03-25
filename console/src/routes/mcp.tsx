import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { deleteMcpServer, fetchMcp, saveMcpServer } from '../api/client';
import type { AdminMcpConfig, AdminMcpServer } from '../api/types';
import { useAuth } from '../auth';
import {
  Banner,
  BooleanField,
  BooleanPill,
  Button,
  EmptyState,
  FormField,
  PageHeader,
  Panel,
  SelectableRow,
} from '../components/ui';

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
  headersJson: string;
}

function formatJson(value: Record<string, string> | undefined): string {
  if (!value || Object.keys(value).length === 0) return '';
  return JSON.stringify(value, null, 2);
}

function createDraft(source?: AdminMcpServer): McpDraft {
  return {
    originalName: source?.name || null,
    name: source?.name || '',
    transport: source?.config.transport || 'stdio',
    enabled: source?.enabled ?? true,
    command: source?.config.command || '',
    args: (source?.config.args || []).join('\n'),
    cwd: source?.config.cwd || '',
    url: source?.config.url || '',
    envJson: formatJson(source?.config.env),
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
            ...(draft.headersJson.trim()
              ? { headers: parseJsonMap(draft.headersJson, 'Headers JSON') }
              : {}),
          }),
    },
  };
}

export function McpPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [draft, setDraft] = useState<McpDraft>(createDraft());

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
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteMcpServer(auth.token, draft.name.trim()),
    onSuccess: (payload) => {
      queryClient.setQueryData(['mcp', auth.token], payload);
      setSelectedName(null);
      setDraft(createDraft());
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

  return (
    <div className="page-stack">
      <PageHeader
        title="MCP"
        actions={
          <Button
            variant="ghost"
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
        <Panel
          title="Servers"
          subtitle={`${mcpQuery.data?.servers.length || 0} configured server${mcpQuery.data?.servers.length === 1 ? '' : 's'}`}
        >
          {mcpQuery.isLoading ? (
            <EmptyState>Loading MCP servers...</EmptyState>
          ) : mcpQuery.data?.servers.length ? (
            <div className="list-stack selectable-list">
              {mcpQuery.data.servers.map((server) => (
                <SelectableRow
                  key={server.name}
                  active={server.name === selectedName}
                  onClick={() => setSelectedName(server.name)}
                >
                  <div>
                    <strong>{server.name}</strong>
                    <small>{server.summary}</small>
                  </div>
                  <BooleanPill
                    value={server.enabled}
                    trueLabel="active"
                    falseLabel="inactive"
                  />
                </SelectableRow>
              ))}
            </div>
          ) : (
            <EmptyState>
              No MCP servers are configured yet.
            </EmptyState>
          )}
        </Panel>

        <Panel title="Server editor" accent="warm">
          <div className="stack-form">
            <div className="field-grid">
              <FormField label="Name">
                <input
                  value={draft.name}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                  placeholder="github"
                />
              </FormField>
              <FormField label="Transport">
                <select
                  value={draft.transport}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      transport: event.target.value as McpDraft['transport'],
                    }))
                  }
                >
                  <option value="stdio">stdio</option>
                  <option value="http">http</option>
                  <option value="sse">sse</option>
                </select>
              </FormField>
            </div>

            <BooleanField
              label="Server state"
              value={draft.enabled}
              trueLabel="on"
              falseLabel="off"
              onChange={(enabled) =>
                setDraft((current) => ({
                  ...current,
                  enabled,
                }))
              }
            />

            {draft.transport === 'stdio' ? (
              <>
                <FormField label="Command">
                  <input
                    value={draft.command}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        command: event.target.value,
                      }))
                    }
                    placeholder="docker"
                  />
                </FormField>
                <div className="field-grid">
                  <FormField label="Arguments">
                    <textarea
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
                  </FormField>
                  <FormField label="Working directory">
                    <input
                      value={draft.cwd}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          cwd: event.target.value,
                        }))
                      }
                      placeholder="/workspace"
                    />
                  </FormField>
                </div>
                <FormField label="Environment JSON">
                  <textarea
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
                </FormField>
              </>
            ) : (
              <>
                <FormField label="URL">
                  <input
                    value={draft.url}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        url: event.target.value,
                      }))
                    }
                    placeholder="https://example.test/mcp"
                  />
                </FormField>
                <FormField label="Headers JSON">
                  <textarea
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
                </FormField>
              </>
            )}

            <div className="button-row">
              <Button
                variant="primary"
                disabled={saveMutation.isPending}
                onClick={() => saveMutation.mutate()}
              >
                {saveMutation.isPending ? 'Saving...' : 'Save server'}
              </Button>
              {selectedServer ? (
                <Button
                  variant="danger"
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

            {saveMutation.isError ? (
              <Banner variant="error">
                {(saveMutation.error as Error).message}
              </Banner>
            ) : null}
            {deleteMutation.isError ? (
              <Banner variant="error">
                {(deleteMutation.error as Error).message}
              </Banner>
            ) : null}
            {saveMutation.isSuccess ? (
              <Banner variant="success">
                Saved MCP server {draft.name.trim()}.
              </Banner>
            ) : null}
          </div>
        </Panel>
      </div>
    </div>
  );
}
