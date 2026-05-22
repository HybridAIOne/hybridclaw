import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { deleteMcpServer, fetchMcp, saveMcpServer } from '../api/client';
import type { AdminMcpConfig, AdminMcpServer } from '../api/types';
import { useAuth } from '../auth';
import { Button } from '../components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/card';
import { Field, FieldContent, FieldLabel } from '../components/field';
import { Input } from '../components/input';
import { NativeSelect, NativeSelectOption } from '../components/native-select';
import { Switch } from '../components/switch';
import { Textarea } from '../components/textarea';
import { useToast } from '../components/toast';
import { BooleanPill, PageHeader } from '../components/ui';
import { getErrorMessage } from '../lib/error-message';

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
  const toast = useToast();
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
                {mcpQuery.data.servers.map((server) => (
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
                      <small>{server.summary}</small>
                    </div>
                    <BooleanPill
                      value={server.enabled}
                      trueLabel="active"
                      falseLabel="inactive"
                    />
                  </button>
                ))}
              </div>
            ) : (
              <div className="empty-state">
                No MCP servers are configured yet.
              </div>
            )}
          </CardContent>
        </Card>

        <Card variant="muted">
          <CardHeader>
            <CardTitle>Server editor</CardTitle>
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
                    <NativeSelectOption value="stdio">stdio</NativeSelectOption>
                    <NativeSelectOption value="http">http</NativeSelectOption>
                    <NativeSelectOption value="sse">sse</NativeSelectOption>
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
                      placeholder="https://example.test/mcp"
                    />
                  </Field>
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
