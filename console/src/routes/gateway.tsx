import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import {
  fetchAdminAgents,
  reloadGateway,
  updateAdminAgent,
} from '../api/client';
import type {
  AdminAgent,
  AdminAgentProxyConversationScope,
} from '../api/types';
import { useAuth } from '../auth';
import { Button } from '../components/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/card';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/dialog';
import { Field, FieldLabel } from '../components/field';
import { Input } from '../components/input';
import { NativeSelect, NativeSelectOption } from '../components/native-select';
import { ProviderHealthPanel } from '../components/provider-health';
import { Switch } from '../components/switch';
import { useToast } from '../components/toast';
import { BooleanPill, MetricCard, PageHeader } from '../components/ui';
import { useLiveConnectionToasts } from '../hooks/use-live-connection-toasts';
import { useLiveEvents } from '../hooks/use-live-events';
import { getErrorMessage } from '../lib/error-message';
import { formatDateTime, formatUptime } from '../lib/format';

const DEFAULT_PROXY_SECRET_ID = 'HYBRIDAI_API_KEY';

function formatAgentLabel(agent: AdminAgent): string {
  return agent.name ? `${agent.name} (${agent.id})` : agent.id;
}

function getProxyAgentFormSyncKey(agent: AdminAgent): string {
  return JSON.stringify({
    id: agent.id,
    chatbotId: agent.chatbotId,
    proxy: agent.proxy || null,
  });
}

function normalizeProxyBaseUrlInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('HybridAI base URL is required.');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('HybridAI base URL must be a valid HTTPS URL.');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('HybridAI base URL must use HTTPS.');
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/g, '');
  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/+$/g, '');
}

export function GatewayPage() {
  const auth = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const live = useLiveEvents(auth.token);
  useLiveConnectionToasts(live.connection);
  const [reloadConfirmOpen, setReloadConfirmOpen] = useState(false);
  const [selectedProxyAgentId, setSelectedProxyAgentId] = useState('');
  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [proxyBaseUrl, setProxyBaseUrl] = useState('');
  const [proxyChatbotId, setProxyChatbotId] = useState('');
  const [proxyApiKeySecretId, setProxyApiKeySecretId] = useState(
    DEFAULT_PROXY_SECRET_ID,
  );
  const [proxyConversationScope, setProxyConversationScope] =
    useState<AdminAgentProxyConversationScope>('channel');
  const lastProxyAgentFormSyncKeyRef = useRef('');
  const status = live.status || auth.gatewayStatus;
  const providerEntries = Object.entries(
    status?.providerHealth || status?.localBackends || {},
  );
  const schedulerJobs = status?.scheduler?.jobs || [];
  const agentsQuery = useQuery({
    queryKey: ['admin-agents', auth.token],
    queryFn: () => fetchAdminAgents(auth.token),
    refetchOnWindowFocus: false,
  });
  const reloadMutation = useMutation({
    mutationFn: () => reloadGateway(auth.token),
    onSuccess: () => {
      toast.success('Gateway reloaded.');
    },
    onError: (error) => {
      toast.error('Gateway reload failed', getErrorMessage(error));
    },
  });

  const navigate = useNavigate();
  const adminAgents = agentsQuery.data || [];
  const selectedProxyAgent =
    adminAgents.find((agent) => agent.id === selectedProxyAgentId) ||
    adminAgents.find((agent) => agent.id === status?.defaultAgentId) ||
    adminAgents[0] ||
    null;

  useEffect(() => {
    if (adminAgents.length === 0) return;
    const nextAgent =
      adminAgents.find((agent) => agent.id === selectedProxyAgentId) ||
      adminAgents.find((agent) => agent.id === status?.defaultAgentId) ||
      adminAgents[0];
    if (!nextAgent) return;
    const syncKey = getProxyAgentFormSyncKey(nextAgent);
    if (nextAgent.id !== selectedProxyAgentId) {
      setSelectedProxyAgentId(nextAgent.id);
    }
    if (lastProxyAgentFormSyncKeyRef.current === syncKey) return;
    lastProxyAgentFormSyncKeyRef.current = syncKey;
    const proxy = nextAgent.proxy || null;
    setProxyEnabled(Boolean(proxy));
    setProxyBaseUrl(proxy?.baseUrl || '');
    setProxyChatbotId(proxy?.chatbotId || nextAgent.chatbotId || '');
    setProxyApiKeySecretId(proxy?.apiKey.id || DEFAULT_PROXY_SECRET_ID);
    setProxyConversationScope(proxy?.conversationScope || 'channel');
  }, [adminAgents, selectedProxyAgentId, status?.defaultAgentId]);

  const proxyMutation = useMutation({
    mutationFn: async () => {
      if (!selectedProxyAgent) {
        throw new Error('Select an agent first.');
      }
      const secretId = proxyApiKeySecretId.trim();
      const proxy = proxyEnabled
        ? {
            kind: 'hybridai' as const,
            baseUrl: normalizeProxyBaseUrlInput(proxyBaseUrl),
            chatbotId: proxyChatbotId.trim(),
            apiKey: {
              source: 'store' as const,
              id: secretId,
            },
            conversationScope: proxyConversationScope,
          }
        : null;
      return updateAdminAgent(auth.token, selectedProxyAgent.id, { proxy });
    },
    onSuccess: (agent) => {
      queryClient.setQueryData<AdminAgent[]>(
        ['admin-agents', auth.token],
        (current) =>
          current?.map((entry) => (entry.id === agent.id ? agent : entry)) || [
            agent,
          ],
      );
      toast.success(`Saved proxy mode for ${agent.name || agent.id}.`);
    },
    onError: (error) => {
      toast.error('Proxy mode update failed', getErrorMessage(error));
    },
  });

  if (!status) {
    return <div className="empty-state">Gateway status is unavailable.</div>;
  }

  const reloadBusy = reloadMutation.isPending;
  const sandboxWarning =
    status.sandbox?.mode === 'host' ? null : status.sandbox?.warning || null;
  return (
    <div className="page-stack">
      <PageHeader
        actions={
          <button
            type="button"
            className="primary-button"
            disabled={reloadBusy}
            onClick={() => setReloadConfirmOpen(true)}
            aria-busy={reloadBusy}
          >
            {reloadBusy ? (
              <span className="button-with-spinner">
                <span aria-hidden="true" className="button-spinner" />
                Reloading Gateway
              </span>
            ) : (
              'Reload Gateway'
            )}
          </button>
        }
      />
      <div className="metric-grid">
        <MetricCard label="Uptime" value={formatUptime(status.uptime)} />
        <MetricCard label="Sessions" value={String(status.sessions)} />
        <MetricCard label="Providers" value={String(providerEntries.length)} />
        <MetricCard
          label="Scheduler jobs"
          value={String(schedulerJobs.length)}
        />
      </div>

      <div className="two-column-grid">
        <Card>
          <CardHeader>
            <CardTitle>Runtime</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="key-value-grid">
              <div>
                <span>Version</span>
                <strong>{status.version}</strong>
              </div>
              <div>
                <span>PID</span>
                <strong>{status.pid ?? 'n/a'}</strong>
              </div>
              <div>
                <span>Timestamp</span>
                <strong>{formatDateTime(status.timestamp)}</strong>
              </div>
              <div>
                <span>Default model</span>
                <strong>{status.defaultModel}</strong>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card variant="muted">
          <CardHeader>
            <CardTitle>Services</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="key-value-grid">
              <div>
                <span>Sandbox mode</span>
                <strong>{status.sandbox?.mode || 'unknown'}</strong>
              </div>
              <div>
                <span>Sandbox sessions</span>
                <strong>
                  {status.sandbox?.activeSessions ?? status.activeContainers}
                </strong>
              </div>
              <div>
                <span>Web API auth</span>
                <BooleanPill
                  value={status.webAuthConfigured}
                  trueLabel="on"
                  falseLabel="off"
                />
              </div>
              <div>
                <span>RAG default</span>
                <BooleanPill
                  value={status.ragDefault}
                  trueLabel="on"
                  falseLabel="off"
                />
              </div>
              <div>
                <span>Observability</span>
                <BooleanPill
                  value={Boolean(
                    status.observability?.enabled &&
                      status.observability?.running,
                  )}
                  trueLabel="active"
                  falseLabel="inactive"
                />
              </div>
              <div>
                <span>Last observability success</span>
                <strong>
                  {formatDateTime(status.observability?.lastSuccessAt || null)}
                </strong>
              </div>
            </div>
            {sandboxWarning ? (
              <p className="error-banner">{sandboxWarning}</p>
            ) : null}
            {status.codex?.reloginRequired ? (
              <p className="error-banner">Codex login is required again.</p>
            ) : null}
            {status.observability?.lastError ? (
              <p className="error-banner">{status.observability.lastError}</p>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <div className="two-column-grid">
        <ProviderHealthPanel
          title="Provider health"
          entries={providerEntries}
          onLogin={() => void navigate({ to: '/admin/config' })}
        />

        <Card>
          <CardHeader>
            <CardTitle>Agent proxy mode</CardTitle>
          </CardHeader>
          <CardContent>
            {agentsQuery.isLoading ? (
              <div className="empty-state">Loading agents...</div>
            ) : adminAgents.length === 0 ? (
              <div className="empty-state">No agents are registered.</div>
            ) : (
              <div className="list-stack">
                <div className="field-grid">
                  <Field>
                    <FieldLabel>Agent</FieldLabel>
                    <NativeSelect
                      value={selectedProxyAgent?.id || ''}
                      onChange={(event) =>
                        setSelectedProxyAgentId(event.target.value)
                      }
                    >
                      {adminAgents.map((agent) => (
                        <NativeSelectOption key={agent.id} value={agent.id}>
                          {formatAgentLabel(agent)}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </Field>

                  <Field>
                    <FieldLabel>Proxy mode</FieldLabel>
                    <div className="button-row">
                      <Switch
                        checked={proxyEnabled}
                        onCheckedChange={setProxyEnabled}
                      />
                      <BooleanPill
                        value={proxyEnabled}
                        trueLabel="on"
                        falseLabel="off"
                      />
                    </div>
                  </Field>

                  {proxyEnabled ? (
                    <>
                      <Field>
                        <FieldLabel>HybridAI base URL</FieldLabel>
                        <Input
                          type="url"
                          value={proxyBaseUrl}
                          placeholder="https://hybridai.example.com"
                          onChange={(event) =>
                            setProxyBaseUrl(event.target.value)
                          }
                        />
                      </Field>
                      <Field>
                        <FieldLabel>Chatbot id</FieldLabel>
                        <Input
                          value={proxyChatbotId}
                          onChange={(event) =>
                            setProxyChatbotId(event.target.value)
                          }
                        />
                      </Field>
                      <Field>
                        <FieldLabel>API key SecretRef id</FieldLabel>
                        <Input
                          value={proxyApiKeySecretId}
                          placeholder={DEFAULT_PROXY_SECRET_ID}
                          onChange={(event) =>
                            setProxyApiKeySecretId(event.target.value)
                          }
                        />
                      </Field>
                      <Field>
                        <FieldLabel>Conversation scope</FieldLabel>
                        <NativeSelect
                          value={proxyConversationScope}
                          onChange={(event) =>
                            setProxyConversationScope(
                              event.target
                                .value as AdminAgentProxyConversationScope,
                            )
                          }
                        >
                          <NativeSelectOption value="channel">
                            channel
                          </NativeSelectOption>
                          <NativeSelectOption value="user">
                            user
                          </NativeSelectOption>
                        </NativeSelect>
                      </Field>
                    </>
                  ) : null}
                </div>
                <div className="button-row">
                  <Button
                    loading={proxyMutation.isPending}
                    disabled={!selectedProxyAgent}
                    onClick={() => proxyMutation.mutate()}
                  >
                    Save Proxy Mode
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card variant="muted">
          <CardHeader>
            <CardTitle>Scheduler snapshot</CardTitle>
          </CardHeader>
          <CardContent>
            {schedulerJobs.length === 0 ? (
              <div className="empty-state">
                No scheduler jobs are registered.
              </div>
            ) : (
              <div className="list-stack">
                {schedulerJobs.slice(0, 8).map((job) => (
                  <div className="list-row" key={job.id}>
                    <div>
                      <strong>{job.name}</strong>
                      <small>
                        {job.nextRunAt
                          ? `next ${formatDateTime(job.nextRunAt)}`
                          : 'no next run scheduled'}
                      </small>
                    </div>
                    <div className="row-status-stack">
                      <BooleanPill
                        value={job.enabled && !job.disabled}
                        trueLabel="active"
                        falseLabel="inactive"
                      />
                      <small>{job.lastStatus || 'ready'}</small>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
      <Dialog open={reloadConfirmOpen} onOpenChange={setReloadConfirmOpen}>
        <DialogContent size="sm" role="alertdialog">
          <DialogHeader>
            <DialogTitle>Reload Gateway?</DialogTitle>
            <DialogDescription>
              This reloads runtime config and refreshes secrets without
              restarting the workspace container.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose className="ghost-button">Cancel</DialogClose>
            <DialogClose
              className="primary-button"
              onClick={() => reloadMutation.mutate()}
            >
              Reload
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
