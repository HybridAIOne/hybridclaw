import type {
  A2ADeliveryStatusResponse,
  AdminA2AInboxResponse,
  AdminA2APairingPreviewResponse,
  AdminA2APairingStartRequest,
  AdminA2APairingStartResponse,
  AdminA2ATrustResponse,
  AdminA2ATrustUpsertRequest,
  AdminAdaptiveSkillAmendmentsResponse,
  AdminAdaptiveSkillHealthResponse,
  AdminAgent,
  AdminAgentMarkdownFileResponse,
  AdminAgentMarkdownRevisionResponse,
  AdminAgentProxyConfig,
  AdminAgentScoreboardResponse,
  AdminAgentsResponse,
  AdminApiTokenCreatePayload,
  AdminApiTokenCreateResponse,
  AdminApiTokenRevokeResponse,
  AdminApiTokensResponse,
  AdminApprovalsResponse,
  AdminAuditResponse,
  AdminBoardBudgetResponse,
  AdminBrowserPoolHealthResponse,
  AdminBrowserPoolLaunchResponse,
  AdminChannelConfig,
  AdminChannelsResponse,
  AdminChannelTransport,
  AdminCommandResult,
  AdminConfig,
  AdminConfigReloadResponse,
  AdminConfigResponse,
  AdminConnectorId,
  AdminConnectorOAuthStartResponse,
  AdminConnectorsResponse,
  AdminConnectorTestResponse,
  AdminCreateSkillPayload,
  AdminDistillConsentPayload,
  AdminDistillResponse,
  AdminDistillRunPayload,
  AdminDistillRunResponse,
  AdminDistillSourceKind,
  AdminDistillSubjectPayload,
  AdminDistillSubjectResponse,
  AdminDistillUploadResponse,
  AdminEmailDeleteResponse,
  AdminEmailFolderResponse,
  AdminEmailMailboxResponse,
  AdminEmailMessageResponse,
  AdminFleetTopologyResponse,
  AdminFleetTopologyUpsertRequest,
  AdminHarnessEvolutionManifestResponse,
  AdminHarnessEvolutionResponse,
  AdminHarnessEvolutionRunResponse,
  AdminHybridAIBot,
  AdminHybridAIBotsResponse,
  AdminInteractionResponse,
  AdminInteractionResumeResponse,
  AdminJobsContextResponse,
  AdminLanHttpAccessMode,
  AdminLogsResponse,
  AdminMcpConfig,
  AdminMcpOAuthStartResponse,
  AdminMcpOAuthStatusResponse,
  AdminMcpResponse,
  AdminModelsResponse,
  AdminMSTeamsTabStatusResponse,
  AdminOutputGuardPreviewResponse,
  AdminOutputGuardProfile,
  AdminOutputGuardProfileResponse,
  AdminOutputGuardProfileUpdateResponse,
  AdminOverview,
  AdminPluginsResponse,
  AdminPolicyRuleInput,
  AdminPolicyState,
  AdminSchedulerBoardStatus,
  AdminSchedulerJob,
  AdminSchedulerResponse,
  AdminSecretMutationResponse,
  AdminSecretsResponse,
  AdminSession,
  AdminSkillInvocationsResponse,
  AdminSkillPackageFileResponse,
  AdminSkillPackageFilesResponse,
  AdminSkillsResponse,
  AdminStatisticsResponse,
  AdminTeamStructureResponse,
  AdminTeamStructureRevisionResponse,
  AdminTerminalStartResponse,
  AdminTerminalStopResponse,
  AdminToolsResponse,
  AdminTunnelConfigInput,
  AdminTunnelConfigResponse,
  AdminTunnelStatus,
  AgentListItem,
  AgentListResponse,
  AgentsOverviewResponse,
  DeleteSessionResult,
  GatewayStatus,
  SignalLinkResponse,
} from './types';

export const TOKEN_STORAGE_KEY = 'hybridclaw_token';
export const AUTH_REQUIRED_EVENT = 'hybridclaw:auth-required';
const LOCAL_TOKEN_BOOTSTRAP_PARAM = '__hybridclaw_token_bootstrapped';
const LOCAL_AUTH_RELOAD_STORAGE_KEY = 'hybridclaw_local_auth_reload_at';
const LOCAL_AUTH_RELOAD_COOLDOWN_MS = 15_000;
let reloadForAuth = () => window.location.reload();

export interface WebCommandRequestBody {
  sessionId: string;
  guildId: null;
  channelId: 'web';
  args: string[];
  userId?: string;
  username?: string;
}

export function requestHeaders(token: string, body?: unknown): HeadersInit {
  const trimmed = token.trim();
  return {
    ...(trimmed ? { Authorization: `Bearer ${trimmed}` } : {}),
    ...(body === undefined
      ? {}
      : {
          'Content-Type': 'application/json',
        }),
  };
}

export function buildWebCommandRequestBody(options: {
  sessionId: string;
  args: string[];
  userId?: string;
  username?: string;
}): WebCommandRequestBody {
  return {
    sessionId: options.sessionId,
    guildId: null,
    channelId: 'web',
    args: options.args,
    ...(options.userId ? { userId: options.userId } : {}),
    ...(options.username ? { username: options.username } : {}),
  };
}

export function dispatchAuthRequired(message: string): void {
  clearStoredToken();
  if (reloadLocalWebSurfaceForAuth()) return;
  window.dispatchEvent(
    new CustomEvent(AUTH_REQUIRED_EVENT, {
      detail: { message },
    }),
  );
}

function reloadLocalWebSurfaceForAuth(): boolean {
  if (!isLocalWebSurfaceLocation()) return false;

  const now = Date.now();
  const lastReloadAt = Number(
    window.sessionStorage.getItem(LOCAL_AUTH_RELOAD_STORAGE_KEY) || '0',
  );
  if (Number.isFinite(lastReloadAt)) {
    const elapsedMs = now - lastReloadAt;
    if (elapsedMs >= 0 && elapsedMs < LOCAL_AUTH_RELOAD_COOLDOWN_MS) {
      return false;
    }
  }

  window.sessionStorage.setItem(LOCAL_AUTH_RELOAD_STORAGE_KEY, String(now));
  reloadForAuth();
  return true;
}

function isLocalWebSurfaceLocation(): boolean {
  if (!isLoopbackHostname(window.location.hostname)) return false;
  const pathname = window.location.pathname;
  return (
    pathname === '/admin' ||
    pathname.startsWith('/admin/') ||
    pathname === '/chat' ||
    pathname.startsWith('/chat/')
  );
}

function isLoopbackHostname(value: string): boolean {
  const hostname = value.toLowerCase();
  return (
    hostname === 'localhost' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}

export function setAuthReloadHandlerForTest(reload: () => void): () => void {
  const previous = reloadForAuth;
  reloadForAuth = reload;
  return () => {
    reloadForAuth = previous;
  };
}

export function isLoopbackHostnameForTest(value: string): boolean {
  return isLoopbackHostname(value);
}

export async function readErrorResponseMessage(
  response: Response,
): Promise<string> {
  const fallback = `${response.status} ${response.statusText}`;
  const text = (await response.text().catch(() => '')).trim();
  if (!text) return fallback;

  try {
    const payload = JSON.parse(text) as {
      error?: string;
      text?: string;
    };
    return payload.error || payload.text || text;
  } catch {
    return text;
  }
}

export class HttpResponseError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'HttpResponseError';
    this.status = status;
  }
}

export async function throwResponseError(
  response: Response,
  options?: { onAuthError?: 'dispatch' | 'ignore' },
): Promise<never> {
  const message = await readErrorResponseMessage(response);
  if (response.status === 401 && options?.onAuthError !== 'ignore') {
    dispatchAuthRequired(message);
  }
  throw new HttpResponseError(message, response.status);
}

export async function requestJson<T>(
  pathname: string,
  options: {
    token: string;
    method?: 'GET' | 'PATCH' | 'PUT' | 'DELETE' | 'POST';
    body?: unknown;
    rawBody?: BodyInit;
    extraHeaders?: HeadersInit;
    onAuthError?: 'dispatch' | 'ignore';
  },
): Promise<T> {
  const response = await fetch(pathname, {
    method: options.method || 'GET',
    headers: {
      ...requestHeaders(options.token, options.body),
      ...options.extraHeaders,
    },
    body:
      options.body !== undefined
        ? JSON.stringify(options.body)
        : (options.rawBody ?? undefined),
  });

  if (!response.ok) {
    await throwResponseError(response, {
      onAuthError: options.onAuthError,
    });
  }
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    text?: string;
  };
  return payload as T;
}

export function readStoredToken(): string {
  removeSearchParams(['token', LOCAL_TOKEN_BOOTSTRAP_PARAM]);
  clearStoredToken();
  return '';
}

function removeSearchParams(names: string[]): void {
  const url = new URL(window.location.href);
  let changed = false;
  for (const name of names) {
    if (!url.searchParams.has(name)) continue;
    url.searchParams.delete(name);
    changed = true;
  }
  if (!changed) return;
  window.history.replaceState(
    window.history.state,
    '',
    `${url.pathname}${url.search}${url.hash}`,
  );
}

export function storeToken(token: string): void {
  void token;
  clearStoredToken();
}

export function clearStoredToken(): void {
  window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  window.localStorage.removeItem(TOKEN_STORAGE_KEY);
}

export function adminEventsUrl(token: string): string {
  void token;
  return '/api/events';
}

export function validateToken(token: string): Promise<GatewayStatus> {
  return requestJson<GatewayStatus>('/api/status', {
    token,
    onAuthError: 'ignore',
  });
}

export function fetchHealth(): Promise<GatewayStatus> {
  return requestJson<GatewayStatus>('/health', {
    token: '',
    onAuthError: 'ignore',
  });
}

export function fetchOverview(token: string): Promise<AdminOverview> {
  return requestJson<AdminOverview>('/api/admin/overview', { token });
}

export function fetchTunnelConfig(
  token: string,
): Promise<AdminTunnelConfigResponse> {
  return requestJson<AdminTunnelConfigResponse>('/api/admin/tunnel', {
    token,
  });
}

export function saveTunnelConfig(
  token: string,
  payload: AdminTunnelConfigInput,
): Promise<AdminTunnelConfigResponse> {
  return requestJson<AdminTunnelConfigResponse>('/api/admin/tunnel', {
    token,
    method: 'PUT',
    body: payload,
  });
}

export async function reconnectTunnel(
  token: string,
): Promise<AdminTunnelStatus> {
  const payload = await requestJson<{ tunnel: AdminTunnelStatus }>(
    '/api/admin/tunnel/reconnect',
    {
      token,
      method: 'POST',
    },
  );
  return payload.tunnel;
}

export async function stopTunnel(token: string): Promise<AdminTunnelStatus> {
  const payload = await requestJson<{ tunnel: AdminTunnelStatus }>(
    '/api/admin/tunnel/stop',
    {
      token,
      method: 'POST',
    },
  );
  return payload.tunnel;
}

export function fetchStatistics(
  token: string,
  days?: number,
): Promise<AdminStatisticsResponse> {
  const search =
    typeof days === 'number' && Number.isFinite(days)
      ? `?days=${Math.max(1, Math.floor(days))}`
      : '';
  return requestJson<AdminStatisticsResponse>(
    `/api/admin/statistics${search}`,
    { token },
  );
}

export function fetchAdminLogs(
  token: string,
  params?: { fileId?: string | null; tailBytes?: number },
): Promise<AdminLogsResponse> {
  const query = new URLSearchParams();
  if (params?.fileId) query.set('file', params.fileId);
  if (params?.tailBytes) query.set('tailBytes', String(params.tailBytes));
  const suffix = query.toString();
  return requestJson<AdminLogsResponse>(
    suffix ? `/api/admin/logs?${suffix}` : '/api/admin/logs',
    { token },
  );
}

export function fetchA2ATrust(token: string): Promise<AdminA2ATrustResponse> {
  return requestJson<AdminA2ATrustResponse>('/api/admin/a2a/trust', { token });
}

export function saveA2ALocalMode(
  token: string,
  enabled: boolean,
): Promise<AdminA2ATrustResponse> {
  return requestJson<AdminA2ATrustResponse>('/api/admin/a2a/local-mode', {
    token,
    method: 'PUT',
    body: { enabled },
  });
}

export function saveA2AE2EERequired(
  token: string,
  required: boolean,
): Promise<AdminA2ATrustResponse> {
  return requestJson<AdminA2ATrustResponse>('/api/admin/a2a/e2ee-required', {
    token,
    method: 'PUT',
    body: { required },
  });
}

export function fetchFleetTopology(
  token: string,
): Promise<AdminFleetTopologyResponse> {
  return requestJson<AdminFleetTopologyResponse>('/api/admin/fleet-topology', {
    token,
  });
}

export function fetchDistill(token: string): Promise<AdminDistillResponse> {
  return requestJson<AdminDistillResponse>('/api/admin/distill', { token });
}

export function saveDistillSubject(
  token: string,
  payload: AdminDistillSubjectPayload,
): Promise<AdminDistillSubjectResponse> {
  return requestJson<AdminDistillSubjectResponse>(
    '/api/admin/distill/subjects',
    {
      token,
      method: 'POST',
      body: payload,
    },
  );
}

export function recordDistillConsent(
  token: string,
  payload: AdminDistillConsentPayload,
): Promise<AdminDistillSubjectResponse> {
  return requestJson<AdminDistillSubjectResponse>(
    '/api/admin/distill/consent',
    {
      token,
      method: 'POST',
      body: payload,
    },
  );
}

export function registerDistillAgent(
  token: string,
  payload: Pick<AdminDistillSubjectPayload, 'agentId' | 'alias'>,
): Promise<AdminDistillSubjectResponse> {
  return requestJson<AdminDistillSubjectResponse>(
    '/api/admin/distill/register',
    {
      token,
      method: 'POST',
      body: payload,
    },
  );
}

export function runDistill(
  token: string,
  payload: AdminDistillRunPayload,
): Promise<AdminDistillRunResponse> {
  return requestJson<AdminDistillRunResponse>('/api/admin/distill/runs', {
    token,
    method: 'POST',
    body: payload,
  });
}

export function uploadDistillSource(
  token: string,
  file: File,
  params: {
    alias: string;
    agentId?: string;
    kind?: AdminDistillSourceKind;
  },
): Promise<AdminDistillUploadResponse> {
  const search = new URLSearchParams({ alias: params.alias });
  if (params.agentId?.trim()) search.set('agentId', params.agentId.trim());
  if (params.kind?.trim()) search.set('kind', params.kind.trim());
  return requestJson<AdminDistillUploadResponse>(
    `/api/admin/distill/sources/upload?${search.toString()}`,
    {
      token,
      method: 'POST',
      rawBody: file,
      extraHeaders: {
        'Content-Type': file.type || 'application/octet-stream',
        'X-Hybridclaw-Filename': encodeURIComponent(file.name || 'source.txt'),
      },
    },
  );
}

function distillCorpusDocumentPath(params: {
  alias: string;
  agentId?: string;
  documentId: string;
}): string {
  const search = new URLSearchParams({ alias: params.alias });
  if (params.agentId?.trim()) search.set('agentId', params.agentId.trim());
  return `/api/admin/distill/corpus/${encodeURIComponent(params.documentId)}?${search.toString()}`;
}

export async function downloadDistillCorpusDocument(
  token: string,
  params: {
    alias: string;
    agentId?: string;
    documentId: string;
  },
): Promise<Blob> {
  const response = await fetch(distillCorpusDocumentPath(params), {
    headers: requestHeaders(token),
    cache: 'no-store',
  });
  if (!response.ok) {
    await throwResponseError(response);
  }
  return response.blob();
}

export function deleteDistillCorpusDocument(
  token: string,
  params: {
    alias: string;
    agentId?: string;
    documentId: string;
  },
): Promise<AdminDistillSubjectResponse> {
  return requestJson<AdminDistillSubjectResponse>(
    distillCorpusDocumentPath(params),
    {
      token,
      method: 'DELETE',
    },
  );
}

export function upsertFleetTopologyInstance(
  token: string,
  body: AdminFleetTopologyUpsertRequest,
): Promise<AdminFleetTopologyResponse> {
  return requestJson<AdminFleetTopologyResponse>('/api/admin/fleet-topology', {
    token,
    method: 'POST',
    body,
  });
}

export function deleteFleetTopologyInstance(
  token: string,
  peerId: string,
): Promise<AdminFleetTopologyResponse> {
  const search = new URLSearchParams({ peerId });
  return requestJson<AdminFleetTopologyResponse>(
    `/api/admin/fleet-topology?${search.toString()}`,
    {
      token,
      method: 'DELETE',
    },
  );
}

export function fetchA2AInbox(
  token: string,
  threadId?: string | null,
): Promise<AdminA2AInboxResponse> {
  const search = threadId?.trim()
    ? `?${new URLSearchParams({ threadId: threadId.trim() }).toString()}`
    : '';
  return requestJson<AdminA2AInboxResponse>(`/api/admin/a2a/inbox${search}`, {
    token,
  });
}

export function fetchA2ADeliveryStatus(
  token: string,
  messageId: string,
): Promise<A2ADeliveryStatusResponse> {
  const search = new URLSearchParams({ messageId }).toString();
  return requestJson<A2ADeliveryStatusResponse>(
    `/api/admin/a2a/outbox/status?${search}`,
    { token },
  );
}

export function revokeA2ATrustPeer(
  token: string,
  params: { peerId: string; reason?: string },
): Promise<AdminA2ATrustResponse> {
  const search = new URLSearchParams({ peerId: params.peerId });
  if (params.reason?.trim()) {
    search.set('reason', params.reason.trim());
  }
  return requestJson<AdminA2ATrustResponse>(
    `/api/admin/a2a/trust?${search.toString()}`,
    {
      token,
      method: 'DELETE',
    },
  );
}

export function upsertA2ATrustPeer(
  token: string,
  body: AdminA2ATrustUpsertRequest,
): Promise<AdminA2ATrustResponse> {
  return requestJson<AdminA2ATrustResponse>('/api/admin/a2a/trust', {
    token,
    method: 'POST',
    body,
  });
}

export function deleteA2ATrustPeer(
  token: string,
  peerId: string,
): Promise<AdminA2ATrustResponse> {
  const search = new URLSearchParams({ peerId, action: 'delete' });
  return requestJson<AdminA2ATrustResponse>(
    `/api/admin/a2a/trust?${search.toString()}`,
    {
      token,
      method: 'DELETE',
    },
  );
}

export function startA2APairing(
  token: string,
  body: AdminA2APairingStartRequest,
): Promise<AdminA2APairingStartResponse> {
  return requestJson<AdminA2APairingStartResponse>('/api/admin/a2a/pairing', {
    token,
    method: 'POST',
    body,
  });
}

export function previewA2APairing(
  token: string,
  body: AdminA2APairingStartRequest,
): Promise<AdminA2APairingPreviewResponse> {
  return requestJson<AdminA2APairingPreviewResponse>(
    '/api/admin/a2a/pairing/preview',
    {
      token,
      method: 'POST',
      body,
    },
  );
}

export function approveA2APairingRequest(
  token: string,
  requestId: string,
  reason?: string,
): Promise<AdminA2ATrustResponse> {
  return requestJson<AdminA2ATrustResponse>('/api/admin/a2a/pairing/approve', {
    token,
    method: 'POST',
    body: { requestId, ...(reason?.trim() ? { reason: reason.trim() } : {}) },
  });
}

export function declineA2APairingRequest(
  token: string,
  requestId: string,
  reason?: string,
): Promise<AdminA2ATrustResponse> {
  return requestJson<AdminA2ATrustResponse>('/api/admin/a2a/pairing/decline', {
    token,
    method: 'POST',
    body: { requestId, ...(reason?.trim() ? { reason: reason.trim() } : {}) },
  });
}

export function reloadGateway(
  token: string,
): Promise<AdminConfigReloadResponse> {
  return requestJson<AdminConfigReloadResponse>('/api/admin/config/reload', {
    token,
    method: 'POST',
  });
}

export function startAdminTerminal(
  token: string,
  payload?: { cols?: number; rows?: number },
): Promise<AdminTerminalStartResponse> {
  return requestJson<AdminTerminalStartResponse>('/api/admin/terminal', {
    token,
    method: 'POST',
    body: payload ?? {},
  });
}

export function stopAdminTerminal(
  token: string,
  sessionId: string,
): Promise<AdminTerminalStopResponse> {
  const params = new URLSearchParams({ sessionId });
  return requestJson<AdminTerminalStopResponse>(
    `/api/admin/terminal?${params.toString()}`,
    {
      token,
      method: 'DELETE',
    },
  );
}

export function adminTerminalSocketUrl(
  _token: string,
  sessionId: string,
): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = new URL(
    `/api/admin/terminal/stream`,
    `${protocol}//${window.location.host}`,
  );
  url.searchParams.set('sessionId', sessionId);
  return url.toString();
}

export function fetchAgentsOverview(
  token: string,
): Promise<AgentsOverviewResponse> {
  return requestJson<AgentsOverviewResponse>('/api/agents', { token });
}

export async function fetchAgentList(token: string): Promise<AgentListItem[]> {
  const payload = await requestJson<AgentListResponse>('/api/agents/list', {
    token,
  });
  const localAgents = payload.agents.map((agent) => ({
    ...agent,
    source: { type: 'local' } as const,
  }));
  const remoteAgents = (payload.remotePeers ?? []).flatMap((peer) =>
    peer.agents.map((agent) => ({
      ...agent,
      source: {
        type: 'remote' as const,
        peerId: peer.peerId,
        instanceId: peer.instanceId,
      },
    })),
  );
  return [...localAgents, ...remoteAgents];
}

export async function fetchAdminAgents(token: string): Promise<AdminAgent[]> {
  const payload = await requestJson<AdminAgentsResponse>('/api/admin/agents', {
    token,
  });
  return payload.agents;
}

export async function fetchAdminHybridAIBots(
  token: string,
  baseUrl?: string,
): Promise<AdminHybridAIBot[]> {
  const params = new URLSearchParams();
  if (baseUrl?.trim()) params.set('baseUrl', baseUrl.trim());
  const query = params.toString();
  const payload = await requestJson<AdminHybridAIBotsResponse>(
    `/api/admin/hybridai/bots${query ? `?${query}` : ''}`,
    { token },
  );
  return payload.bots;
}

export async function updateAdminAgent(
  token: string,
  agentId: string,
  payload: {
    proxy?: AdminAgentProxyConfig | null;
    routing?: AdminAgent['routing'];
    archived?: boolean;
  },
): Promise<AdminAgent> {
  const response = await requestJson<{ agent: AdminAgent }>(
    `/api/admin/agents/${encodeURIComponent(agentId)}`,
    {
      token,
      method: 'PUT',
      body: payload,
    },
  );
  return response.agent;
}

export function fetchAdminTeamStructure(
  token: string,
): Promise<AdminTeamStructureResponse> {
  return requestJson<AdminTeamStructureResponse>('/api/admin/team-structure', {
    token,
  });
}

export function fetchAdminTeamStructureRevision(
  token: string,
  revisionId: number,
): Promise<AdminTeamStructureRevisionResponse> {
  return requestJson<AdminTeamStructureRevisionResponse>(
    `/api/admin/team-structure/revisions/${encodeURIComponent(String(revisionId))}`,
    { token },
  );
}

export function restoreAdminTeamStructureRevision(
  token: string,
  revisionId: number,
): Promise<AdminTeamStructureResponse> {
  return requestJson<AdminTeamStructureResponse>(
    `/api/admin/team-structure/revisions/${encodeURIComponent(String(revisionId))}/restore`,
    {
      token,
      method: 'POST',
    },
  );
}

export function fetchAdminAgentMarkdownFile(
  token: string,
  params: {
    agentId: string;
    fileName: string;
  },
): Promise<AdminAgentMarkdownFileResponse> {
  return requestJson<AdminAgentMarkdownFileResponse>(
    `/api/admin/agents/${encodeURIComponent(params.agentId)}/files/${encodeURIComponent(params.fileName)}`,
    { token },
  );
}

export function saveAdminAgentMarkdownFile(
  token: string,
  params: {
    agentId: string;
    fileName: string;
    content: string;
  },
): Promise<AdminAgentMarkdownFileResponse> {
  return requestJson<AdminAgentMarkdownFileResponse>(
    `/api/admin/agents/${encodeURIComponent(params.agentId)}/files/${encodeURIComponent(params.fileName)}`,
    {
      token,
      method: 'PUT',
      body: { content: params.content },
    },
  );
}

export function fetchAdminAgentMarkdownRevision(
  token: string,
  params: {
    agentId: string;
    fileName: string;
    revisionId: string;
  },
): Promise<AdminAgentMarkdownRevisionResponse> {
  return requestJson<AdminAgentMarkdownRevisionResponse>(
    `/api/admin/agents/${encodeURIComponent(params.agentId)}/files/${encodeURIComponent(params.fileName)}/revisions/${encodeURIComponent(params.revisionId)}`,
    { token },
  );
}

export function restoreAdminAgentMarkdownRevision(
  token: string,
  params: {
    agentId: string;
    fileName: string;
    revisionId: string;
  },
): Promise<AdminAgentMarkdownFileResponse> {
  return requestJson<AdminAgentMarkdownFileResponse>(
    `/api/admin/agents/${encodeURIComponent(params.agentId)}/files/${encodeURIComponent(params.fileName)}/revisions/${encodeURIComponent(params.revisionId)}/restore`,
    {
      token,
      method: 'POST',
    },
  );
}

export function fetchJobsContext(
  token: string,
): Promise<AdminJobsContextResponse> {
  return requestJson<AdminJobsContextResponse>('/api/admin/jobs/context', {
    token,
  });
}

export function fetchBoardBudgetSummaries(
  token: string,
  agentIds?: string[],
): Promise<AdminBoardBudgetResponse> {
  const params = new URLSearchParams();
  for (const agentId of agentIds || []) {
    const normalized = agentId.trim();
    if (normalized) params.append('agentId', normalized);
  }
  const query = params.toString();
  return requestJson<AdminBoardBudgetResponse>(
    `/api/admin/jobs/budgets${query ? `?${query}` : ''}`,
    { token },
  );
}

export async function fetchSessions(token: string): Promise<AdminSession[]> {
  const payload = await requestJson<{ sessions: AdminSession[] }>(
    '/api/admin/sessions',
    { token },
  );
  return payload.sessions;
}

export function fetchAdminEmailMailbox(
  token: string,
): Promise<AdminEmailMailboxResponse> {
  return requestJson<AdminEmailMailboxResponse>('/api/admin/email', { token });
}

export function fetchAdminEmailFolder(
  token: string,
  params: {
    folder: string;
    limit?: number;
    offset?: number;
  },
): Promise<AdminEmailFolderResponse> {
  const query = new URLSearchParams({ folder: params.folder });
  if (typeof params.limit === 'number') {
    query.set('limit', String(params.limit));
  }
  if (typeof params.offset === 'number') {
    query.set('offset', String(params.offset));
  }
  return requestJson<AdminEmailFolderResponse>(
    `/api/admin/email/messages?${query.toString()}`,
    {
      token,
    },
  );
}

export function fetchAdminEmailMessage(
  token: string,
  params: {
    folder: string;
    uid: number;
  },
): Promise<AdminEmailMessageResponse> {
  const query = new URLSearchParams({
    folder: params.folder,
    uid: String(params.uid),
  });
  return requestJson<AdminEmailMessageResponse>(
    `/api/admin/email/message?${query.toString()}`,
    {
      token,
    },
  );
}

export function deleteAdminEmailMessage(
  token: string,
  params: {
    folder: string;
    uid: number;
  },
): Promise<AdminEmailDeleteResponse> {
  const query = new URLSearchParams({
    folder: params.folder,
    uid: String(params.uid),
  });
  return requestJson<AdminEmailDeleteResponse>(
    `/api/admin/email/message?${query.toString()}`,
    {
      token,
      method: 'DELETE',
    },
  );
}

export function deleteSession(
  token: string,
  sessionId: string,
  options?: {
    onlyWithoutUserMessages?: boolean;
  },
): Promise<DeleteSessionResult> {
  const params = new URLSearchParams({ sessionId });
  if (options?.onlyWithoutUserMessages) {
    params.set('ifNoUserMessages', '1');
  }
  return requestJson<DeleteSessionResult>(
    `/api/admin/sessions?${params.toString()}`,
    {
      token,
      method: 'DELETE',
    },
  );
}

export function fetchChannels(token: string): Promise<AdminChannelsResponse> {
  return requestJson<AdminChannelsResponse>('/api/admin/channels', { token });
}

export function saveChannel(
  token: string,
  payload: {
    transport?: AdminChannelTransport;
    guildId: string;
    channelId: string;
    config: AdminChannelConfig;
  },
): Promise<AdminChannelsResponse> {
  return requestJson<AdminChannelsResponse>('/api/admin/channels', {
    token,
    method: 'PUT',
    body: payload,
  });
}

export function deleteChannel(
  token: string,
  transport: AdminChannelTransport,
  guildId: string,
  channelId: string,
): Promise<AdminChannelsResponse> {
  const params = new URLSearchParams({ transport, guildId, channelId });
  return requestJson<AdminChannelsResponse>(
    `/api/admin/channels?${params.toString()}`,
    {
      token,
      method: 'DELETE',
    },
  );
}

export function fetchConfig(token: string): Promise<AdminConfigResponse> {
  return requestJson<AdminConfigResponse>('/api/admin/config', { token });
}

export function fetchMSTeamsTabStatus(
  token: string,
): Promise<AdminMSTeamsTabStatusResponse> {
  return requestJson<AdminMSTeamsTabStatusResponse>(
    '/api/admin/msteams/tab-status',
    { token },
  );
}

export async function downloadMSTeamsOrgManifest(token: string): Promise<Blob> {
  const response = await fetch('/api/admin/msteams/tab-manifest', {
    headers: requestHeaders(token),
  });
  if (!response.ok) {
    await throwResponseError(response);
  }
  return response.blob();
}

export function fetchBrowserPoolHealth(
  token: string,
): Promise<AdminBrowserPoolHealthResponse> {
  return requestJson<AdminBrowserPoolHealthResponse>(
    '/api/admin/browser-pool/health',
    { token },
  );
}

export function startBrowserPool(
  token: string,
): Promise<AdminBrowserPoolLaunchResponse> {
  return requestJson<AdminBrowserPoolLaunchResponse>(
    '/api/admin/browser-pool/start',
    {
      method: 'POST',
      token,
    },
  );
}

export function fetchEmailConfig(
  token: string,
  options: { handleId?: string | null } = {},
): Promise<unknown> {
  const query = new URLSearchParams();
  const handleId = String(options.handleId || '').trim();
  if (handleId) query.set('handleId', handleId);
  const queryString = query.toString();
  const suffix = queryString ? `?${queryString}` : '';
  return requestJson<unknown>(`/api/admin/email-config/fetch${suffix}`, {
    token,
  });
}

export function saveConfig(
  token: string,
  config: AdminConfig,
): Promise<AdminConfigResponse> {
  return requestJson<AdminConfigResponse>('/api/admin/config', {
    token,
    method: 'PUT',
    body: { config },
  });
}

export function saveSlackWebhookTarget(
  token: string,
  payload: {
    target: string;
    webhookUrl?: string;
    defaultUsername?: string;
    defaultIconEmoji?: string;
    defaultIconUrl?: string;
  },
): Promise<AdminConfigResponse> {
  return requestJson<AdminConfigResponse>('/api/admin/slack-webhook-targets', {
    token,
    method: 'PUT',
    body: payload,
  });
}

export function saveDiscordWebhookTarget(
  token: string,
  payload: {
    target: string;
    webhookUrl?: string;
    defaultUsername?: string;
    defaultAvatarUrl?: string;
  },
): Promise<AdminConfigResponse> {
  return requestJson<AdminConfigResponse>(
    '/api/admin/discord-webhook-targets',
    {
      token,
      method: 'PUT',
      body: payload,
    },
  );
}

export function startSignalLink(
  token: string,
  options: { cliPath?: string; deviceName?: string },
): Promise<SignalLinkResponse> {
  return requestJson<SignalLinkResponse>('/api/admin/signal/link', {
    token,
    method: 'POST',
    body: options,
  });
}

export function fetchSignalLink(token: string): Promise<SignalLinkResponse> {
  return requestJson<SignalLinkResponse>('/api/admin/signal/link', { token });
}

function runAdminCommand(
  token: string,
  sessionId: string,
  args: string[],
): Promise<AdminCommandResult> {
  return requestJson<AdminCommandResult>('/api/command', {
    token,
    method: 'POST',
    body: buildWebCommandRequestBody({
      sessionId,
      args,
    }),
  });
}

export function setRuntimeSecret(
  token: string,
  secretName: string,
  secretValue: string,
): Promise<AdminCommandResult> {
  return runAdminCommand(token, 'web-admin-secrets', [
    'secret',
    'set',
    secretName,
    secretValue,
  ]);
}

export function installPlugin(
  token: string,
  source: string,
): Promise<AdminCommandResult> {
  return runAdminCommand(token, 'web-admin-channels', [
    'plugin',
    'install',
    source,
    '--yes',
  ]);
}

export function fetchAdminSecrets(
  token: string,
): Promise<AdminSecretsResponse> {
  return requestJson<AdminSecretsResponse>('/api/admin/secrets', { token });
}

export function overwriteAdminSecret(
  token: string,
  name: string,
  value: string,
): Promise<AdminSecretMutationResponse> {
  return requestJson<AdminSecretMutationResponse>(
    `/api/admin/secrets/${encodeURIComponent(name)}`,
    {
      token,
      method: 'PUT',
      body: { value },
    },
  );
}

export function unsetAdminSecret(
  token: string,
  name: string,
): Promise<AdminSecretMutationResponse> {
  return requestJson<AdminSecretMutationResponse>(
    `/api/admin/secrets/${encodeURIComponent(name)}`,
    {
      token,
      method: 'DELETE',
    },
  );
}

export function fetchAdminApiTokens(
  token: string,
): Promise<AdminApiTokensResponse> {
  return requestJson<AdminApiTokensResponse>('/api/admin/tokens', { token });
}

export function createAdminApiToken(
  token: string,
  payload: AdminApiTokenCreatePayload,
): Promise<AdminApiTokenCreateResponse> {
  return requestJson<AdminApiTokenCreateResponse>('/api/admin/tokens', {
    token,
    method: 'POST',
    body: payload,
  });
}

export function revokeAdminApiToken(
  token: string,
  id: string,
): Promise<AdminApiTokenRevokeResponse> {
  return requestJson<AdminApiTokenRevokeResponse>(
    `/api/admin/tokens/${encodeURIComponent(id)}`,
    {
      token,
      method: 'DELETE',
    },
  );
}

export function fetchModels(token: string): Promise<AdminModelsResponse> {
  return requestJson<AdminModelsResponse>('/api/admin/models', { token });
}

export function saveModels(
  token: string,
  payload: {
    defaultModel: string;
  },
): Promise<AdminModelsResponse> {
  return requestJson<AdminModelsResponse>('/api/admin/models', {
    token,
    method: 'PUT',
    body: payload,
  });
}

export function fetchScheduler(token: string): Promise<AdminSchedulerResponse> {
  return requestJson<AdminSchedulerResponse>('/api/admin/scheduler', { token });
}

export function saveSchedulerJob(
  token: string,
  job: AdminSchedulerJob,
): Promise<AdminSchedulerResponse> {
  return requestJson<AdminSchedulerResponse>('/api/admin/scheduler', {
    token,
    method: 'PUT',
    body: { job },
  });
}

export function deleteSchedulerJob(
  token: string,
  job: Pick<AdminSchedulerJob, 'source' | 'id' | 'taskId'>,
): Promise<AdminSchedulerResponse> {
  const params = new URLSearchParams(
    job.source === 'task'
      ? {
          source: 'task',
          taskId: String(job.taskId ?? ''),
        }
      : {
          jobId: job.id,
        },
  );
  return requestJson<AdminSchedulerResponse>(
    `/api/admin/scheduler?${params.toString()}`,
    {
      token,
      method: 'DELETE',
    },
  );
}

export function setSchedulerJobPaused(
  token: string,
  payload:
    | { source: 'job'; jobId: string; action: 'pause' | 'resume' }
    | { source: 'task'; taskId: number; action: 'pause' | 'resume' },
): Promise<AdminSchedulerResponse> {
  return requestJson<AdminSchedulerResponse>('/api/admin/scheduler', {
    token,
    method: 'POST',
    body: payload,
  });
}

export function moveSchedulerJob(
  token: string,
  payload: {
    jobId: string;
    beforeJobId?: string | null;
    boardStatus?: AdminSchedulerBoardStatus | null;
  },
): Promise<AdminSchedulerResponse> {
  return requestJson<AdminSchedulerResponse>('/api/admin/scheduler', {
    token,
    method: 'POST',
    body: {
      action: 'move',
      ...payload,
    },
  });
}

export function fetchMcp(token: string): Promise<AdminMcpResponse> {
  return requestJson<AdminMcpResponse>('/api/admin/mcp', { token });
}

export function fetchConnectors(
  token: string,
): Promise<AdminConnectorsResponse> {
  return requestJson<AdminConnectorsResponse>('/api/admin/connectors', {
    token,
  });
}

export function saveHybridAIConnectorKey(
  token: string,
  apiKey: string,
): Promise<AdminConnectorsResponse> {
  return requestJson<AdminConnectorsResponse>(
    '/api/admin/connectors/hybridai/key',
    {
      token,
      method: 'PUT',
      body: { apiKey },
    },
  );
}

export function startConnectorOAuth(
  token: string,
  payload: {
    provider: Exclude<AdminConnectorId, 'hybridai'>;
    account?: string;
    tenantId?: string;
    clientId?: string;
    clientSecret?: string;
    scopes?: string;
  },
): Promise<AdminConnectorOAuthStartResponse> {
  return requestJson<AdminConnectorOAuthStartResponse>(
    '/api/admin/connectors/oauth/start',
    {
      token,
      method: 'POST',
      body: payload,
    },
  );
}

export function logoutConnector(
  token: string,
  provider: AdminConnectorId,
): Promise<AdminConnectorsResponse> {
  return requestJson<AdminConnectorsResponse>('/api/admin/connectors/logout', {
    token,
    method: 'POST',
    body: { provider },
  });
}

export function testConnector(
  token: string,
  provider: AdminConnectorId,
): Promise<AdminConnectorTestResponse> {
  return requestJson<AdminConnectorTestResponse>('/api/admin/connectors/test', {
    token,
    method: 'POST',
    body: { provider },
  });
}

export function saveMcpServer(
  token: string,
  payload: { name: string; config: AdminMcpConfig },
): Promise<AdminMcpResponse> {
  return requestJson<AdminMcpResponse>('/api/admin/mcp', {
    token,
    method: 'PUT',
    body: payload,
  });
}

export function deleteMcpServer(
  token: string,
  name: string,
): Promise<AdminMcpResponse> {
  const params = new URLSearchParams({ name });
  return requestJson<AdminMcpResponse>(`/api/admin/mcp?${params.toString()}`, {
    token,
    method: 'DELETE',
  });
}

export function startMcpOAuth(
  token: string,
  name: string,
): Promise<AdminMcpOAuthStartResponse> {
  return requestJson<AdminMcpOAuthStartResponse>('/api/admin/mcp/oauth/start', {
    token,
    method: 'POST',
    body: { name },
  });
}

export function fetchMcpOAuthStatus(
  token: string,
  name: string,
): Promise<AdminMcpOAuthStatusResponse> {
  const params = new URLSearchParams({ name });
  return requestJson<AdminMcpOAuthStatusResponse>(
    `/api/admin/mcp/oauth/status?${params.toString()}`,
    { token },
  );
}

export function logoutMcpOAuth(
  token: string,
  name: string,
): Promise<AdminMcpResponse> {
  return requestJson<AdminMcpResponse>('/api/admin/mcp/oauth/logout', {
    token,
    method: 'POST',
    body: { name },
  });
}

export function fetchAudit(
  token: string,
  params: {
    query?: string;
    sessionId?: string;
    eventType?: string;
    since?: string;
    until?: string;
    cursor?: number;
    limit?: number;
  },
): Promise<AdminAuditResponse> {
  const queryParams = new URLSearchParams();
  if (params.query) queryParams.set('query', params.query);
  if (params.sessionId) queryParams.set('sessionId', params.sessionId);
  if (params.eventType) queryParams.set('eventType', params.eventType);
  if (params.since) queryParams.set('since', params.since);
  if (params.until) queryParams.set('until', params.until);
  if (typeof params.cursor === 'number' && params.cursor > 0) {
    queryParams.set('cursor', String(params.cursor));
  }
  if (typeof params.limit === 'number') {
    queryParams.set('limit', String(params.limit));
  }
  const suffix = queryParams.toString();
  return requestJson<AdminAuditResponse>(
    suffix ? `/api/admin/audit?${suffix}` : '/api/admin/audit',
    { token },
  );
}

export function fetchAdminApprovals(
  token: string,
  params?: {
    agentId?: string;
  },
): Promise<AdminApprovalsResponse> {
  const queryParams = new URLSearchParams();
  if (params?.agentId) {
    queryParams.set('agentId', params.agentId);
  }
  const suffix = queryParams.toString();
  return requestJson<AdminApprovalsResponse>(
    suffix ? `/api/admin/approvals?${suffix}` : '/api/admin/approvals',
    { token },
  );
}

export function resumeInteractiveEscalation(
  token: string,
  params: {
    sessionId: string;
    response?: AdminInteractionResponse;
    text?: string;
  },
): Promise<AdminInteractionResumeResponse> {
  return requestJson<AdminInteractionResumeResponse>(
    '/api/interactive-escalations/resume',
    {
      token,
      method: 'POST',
      body: params,
    },
  );
}

export function saveAdminPolicyRule(
  token: string,
  params: {
    agentId: string;
    index?: number;
    rule: AdminPolicyRuleInput;
  },
): Promise<AdminPolicyState> {
  return requestJson<AdminPolicyState>('/api/admin/policy', {
    token,
    method: 'PUT',
    body: params,
  });
}

export function saveAdminPolicyDefault(
  token: string,
  params: {
    agentId: string;
    defaultAction: 'allow' | 'deny';
  },
): Promise<AdminPolicyState> {
  return requestJson<AdminPolicyState>('/api/admin/policy', {
    token,
    method: 'PUT',
    body: params,
  });
}

export function saveAdminPolicyLanHttpAccess(
  token: string,
  params: {
    agentId: string;
    mode: AdminLanHttpAccessMode;
  },
): Promise<AdminPolicyState> {
  return requestJson<AdminPolicyState>('/api/admin/policy', {
    token,
    method: 'PUT',
    body: {
      agentId: params.agentId,
      lanHttpAccessMode: params.mode,
    },
  });
}

export function saveAdminPolicyPreset(
  token: string,
  params: {
    agentId: string;
    presetName: string;
  },
): Promise<AdminPolicyState> {
  return requestJson<AdminPolicyState>('/api/admin/policy', {
    token,
    method: 'PUT',
    body: params,
  });
}

export function deleteAdminPolicyRule(
  token: string,
  params: {
    agentId: string;
    index: number;
  },
): Promise<AdminPolicyState> {
  const query = new URLSearchParams({
    agentId: params.agentId,
    index: String(params.index),
  });
  return requestJson<AdminPolicyState>(
    `/api/admin/policy?${query.toString()}`,
    {
      token,
      method: 'DELETE',
    },
  );
}

export function fetchSkills(token: string): Promise<AdminSkillsResponse> {
  return requestJson<AdminSkillsResponse>('/api/admin/skills', { token });
}

export function createSkill(
  token: string,
  payload: AdminCreateSkillPayload,
): Promise<AdminSkillsResponse> {
  return requestJson<AdminSkillsResponse>('/api/admin/skills', {
    token,
    method: 'POST',
    body: payload,
  });
}

export function uploadSkillZip(
  token: string,
  file: File,
  options?: { force?: boolean },
): Promise<AdminSkillsResponse> {
  const path = options?.force
    ? '/api/admin/skills/upload?force=true'
    : '/api/admin/skills/upload';
  return requestJson<AdminSkillsResponse>(path, {
    token,
    method: 'POST',
    rawBody: file,
    extraHeaders: {
      'Content-Type': 'application/zip',
    },
  });
}

export function unblockSkill(
  token: string,
  skillName: string,
): Promise<AdminSkillsResponse> {
  return requestJson<AdminSkillsResponse>('/api/admin/skills/unblock', {
    token,
    method: 'POST',
    body: { name: skillName },
  });
}

export function fetchSkillPackageFiles(
  token: string,
  skillName: string,
): Promise<AdminSkillPackageFilesResponse> {
  return requestJson<AdminSkillPackageFilesResponse>(
    `/api/admin/skills/${encodeURIComponent(skillName)}/files`,
    { token },
  );
}

export function fetchSkillInvocations(
  token: string,
  skillName: string,
): Promise<AdminSkillInvocationsResponse> {
  return requestJson<AdminSkillInvocationsResponse>(
    `/api/admin/skills/${encodeURIComponent(skillName)}/invocations`,
    { token },
  );
}

export function fetchSkillPackageFile(
  token: string,
  params: { skillName: string; path: string },
): Promise<AdminSkillPackageFileResponse> {
  return requestJson<AdminSkillPackageFileResponse>(
    `/api/admin/skills/${encodeURIComponent(params.skillName)}/files/content?path=${encodeURIComponent(params.path)}`,
    { token },
  );
}

export function saveSkillPackageFile(
  token: string,
  params: { skillName: string; path: string; content: string },
): Promise<AdminSkillPackageFileResponse> {
  return requestJson<AdminSkillPackageFileResponse>(
    `/api/admin/skills/${encodeURIComponent(params.skillName)}/files/content?path=${encodeURIComponent(params.path)}`,
    {
      token,
      method: 'PUT',
      body: { content: params.content },
    },
  );
}

export function fetchPlugins(token: string): Promise<AdminPluginsResponse> {
  return requestJson<AdminPluginsResponse>('/api/admin/plugins', { token });
}

export function fetchOutputGuardProfile(
  token: string,
): Promise<AdminOutputGuardProfileResponse> {
  return requestJson<AdminOutputGuardProfileResponse>(
    '/api/admin/output-guard',
    {
      token,
    },
  );
}

export function saveOutputGuardProfile(
  token: string,
  profile: AdminOutputGuardProfile,
): Promise<AdminOutputGuardProfileUpdateResponse> {
  return requestJson<AdminOutputGuardProfileUpdateResponse>(
    '/api/admin/output-guard',
    {
      token,
      method: 'PUT',
      body: { profile },
    },
  );
}

export function previewOutputGuardProfile(
  token: string,
  profile: AdminOutputGuardProfile,
  sample: string,
): Promise<AdminOutputGuardPreviewResponse> {
  return requestJson<AdminOutputGuardPreviewResponse>(
    '/api/admin/output-guard/preview',
    {
      token,
      method: 'POST',
      body: { profile, sample },
    },
  );
}

export function fetchAdaptiveSkillHealth(
  token: string,
): Promise<AdminAdaptiveSkillHealthResponse> {
  return requestJson<AdminAdaptiveSkillHealthResponse>('/api/skills/health', {
    token,
  });
}

export function fetchAgentScoreboard(
  token: string,
): Promise<AdminAgentScoreboardResponse> {
  return requestJson<AdminAgentScoreboardResponse>(
    '/api/admin/agent-scoreboard',
    { token },
  );
}

export function fetchHarnessEvolutionRuns(
  token: string,
  targetRoot: string,
): Promise<AdminHarnessEvolutionResponse> {
  const params = new URLSearchParams({ targetRoot });
  return requestJson<AdminHarnessEvolutionResponse>(
    `/api/admin/harness-evolution?${params.toString()}`,
    { token },
  );
}

export function fetchHarnessEvolutionRun(
  token: string,
  targetRoot: string,
  summaryPath: string,
): Promise<AdminHarnessEvolutionRunResponse> {
  const params = new URLSearchParams({ targetRoot, summaryPath });
  return requestJson<AdminHarnessEvolutionRunResponse>(
    `/api/admin/harness-evolution?${params.toString()}`,
    { token },
  );
}

export function fetchHarnessEvolutionManifest(
  token: string,
  targetRoot: string,
  manifestPath: string,
): Promise<AdminHarnessEvolutionManifestResponse> {
  const params = new URLSearchParams({ targetRoot, manifestPath });
  return requestJson<AdminHarnessEvolutionManifestResponse>(
    `/api/admin/harness-evolution?${params.toString()}`,
    { token },
  );
}

export function fetchAdaptiveSkillAmendments(
  token: string,
): Promise<AdminAdaptiveSkillAmendmentsResponse> {
  return requestJson<AdminAdaptiveSkillAmendmentsResponse>(
    '/api/skills/amendments',
    { token },
  );
}

export function fetchAdaptiveSkillAmendmentHistory(
  token: string,
  skillName: string,
): Promise<AdminAdaptiveSkillAmendmentsResponse> {
  return requestJson<AdminAdaptiveSkillAmendmentsResponse>(
    `/api/skills/amendments/${encodeURIComponent(skillName)}`,
    { token },
  );
}

export function applyAdaptiveSkillAmendment(
  token: string,
  skillName: string,
  reviewedBy = 'console',
): Promise<{ ok: boolean; reason?: string; amendmentId?: number }> {
  return requestJson<{ ok: boolean; reason?: string; amendmentId?: number }>(
    `/api/skills/amendments/${encodeURIComponent(skillName)}/apply`,
    {
      token,
      method: 'POST',
      body: { reviewedBy },
    },
  );
}

export function rejectAdaptiveSkillAmendment(
  token: string,
  skillName: string,
  reviewedBy = 'console',
): Promise<{ ok: boolean; reason?: string; amendmentId?: number }> {
  return requestJson<{ ok: boolean; reason?: string; amendmentId?: number }>(
    `/api/skills/amendments/${encodeURIComponent(skillName)}/reject`,
    {
      token,
      method: 'POST',
      body: { reviewedBy },
    },
  );
}

export function fetchTools(token: string): Promise<AdminToolsResponse> {
  return requestJson<AdminToolsResponse>('/api/admin/tools', { token });
}

export function saveSkillEnabled(
  token: string,
  payload: { name: string; enabled: boolean },
): Promise<AdminSkillsResponse> {
  return requestJson<AdminSkillsResponse>('/api/admin/skills', {
    token,
    method: 'PUT',
    body: payload,
  });
}
