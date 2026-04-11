import type {
  AdminAdaptiveSkillAmendmentsResponse,
  AdminAdaptiveSkillHealthResponse,
  AdminAuditResponse,
  AdminChannelConfig,
  AdminChannelsResponse,
  AdminChannelTransport,
  AdminCommandResult,
  AdminConfig,
  AdminConfigResponse,
  AdminCreateSkillPayload,
  AdminEmailDeleteResponse,
  AdminEmailFolderResponse,
  AdminEmailMailboxResponse,
  AdminEmailMessageResponse,
  AdminJobsContextResponse,
  AdminMcpConfig,
  AdminMcpResponse,
  AdminModelsResponse,
  AdminOverview,
  AdminPluginsResponse,
  AdminSchedulerBoardStatus,
  AdminSchedulerJob,
  AdminSchedulerResponse,
  AdminSession,
  AdminSkillsResponse,
  AdminTerminalStartResponse,
  AdminTerminalStopResponse,
  AdminToolsResponse,
  AgentsOverview,
  AgentsOverviewResponse,
  DeleteSessionResult,
  GatewayStatus,
} from './types';

export const TOKEN_STORAGE_KEY = 'hybridclaw_token';
export const AUTH_REQUIRED_EVENT = 'hybridclaw:auth-required';

function requestHeaders(token: string, body?: unknown): HeadersInit {
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

function dispatchAuthRequired(message: string): void {
  clearStoredToken();
  window.dispatchEvent(
    new CustomEvent(AUTH_REQUIRED_EVENT, {
      detail: { message },
    }),
  );
}

async function requestJson<T>(
  pathname: string,
  options: {
    token: string;
    method?: 'GET' | 'PUT' | 'DELETE' | 'POST';
    body?: unknown;
    onAuthError?: 'dispatch' | 'ignore';
  },
): Promise<T> {
  const response = await fetch(pathname, {
    method: options.method || 'GET',
    headers: requestHeaders(options.token, options.body),
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    text?: string;
  };
  if (!response.ok) {
    const message =
      payload.error ||
      payload.text ||
      `${response.status} ${response.statusText}`;
    if (response.status === 401 && options.onAuthError !== 'ignore') {
      dispatchAuthRequired(message);
    }
    throw new Error(message);
  }
  return payload as T;
}

export function readStoredToken(): string {
  const search = new URLSearchParams(window.location.search);
  const queryToken = (search.get('token') || '').trim();
  if (queryToken) {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, queryToken);
    return queryToken;
  }
  return window.localStorage.getItem(TOKEN_STORAGE_KEY) || '';
}

export function storeToken(token: string): void {
  window.localStorage.setItem(TOKEN_STORAGE_KEY, token.trim());
}

export function clearStoredToken(): void {
  window.localStorage.removeItem(TOKEN_STORAGE_KEY);
}

export function adminEventsUrl(token: string): string {
  const trimmed = token.trim();
  if (!trimmed) return '/api/events';
  const params = new URLSearchParams({ token: trimmed });
  return `/api/events?${params.toString()}`;
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

export function restartGateway(
  token: string,
): Promise<{ status: 'ok'; message: string }> {
  return requestJson<{ status: 'ok'; message: string }>('/api/admin/restart', {
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

export function fetchAgentsOverview(token: string): Promise<AgentsOverview> {
  return requestJson<AgentsOverviewResponse>('/api/agents', { token });
}

export function fetchJobsContext(
  token: string,
): Promise<AdminJobsContextResponse> {
  return requestJson<AdminJobsContextResponse>('/api/admin/jobs/context', {
    token,
  });
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
  },
): Promise<AdminEmailFolderResponse> {
  const query = new URLSearchParams({ folder: params.folder });
  if (typeof params.limit === 'number') {
    query.set('limit', String(params.limit));
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
): Promise<DeleteSessionResult> {
  const params = new URLSearchParams({ sessionId });
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

function runAdminCommand(
  token: string,
  args: string[],
): Promise<AdminCommandResult> {
  return requestJson<AdminCommandResult>('/api/command', {
    token,
    method: 'POST',
    body: {
      sessionId: 'web-admin-secrets',
      guildId: null,
      channelId: 'web',
      args,
    },
  });
}

export function setRuntimeSecret(
  token: string,
  secretName: string,
  secretValue: string,
): Promise<AdminCommandResult> {
  return runAdminCommand(token, ['secret', 'set', secretName, secretValue]);
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
    | { source: 'config'; jobId: string; action: 'pause' | 'resume' }
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

export function fetchAudit(
  token: string,
  params: {
    query?: string;
    sessionId?: string;
    eventType?: string;
    limit?: number;
  },
): Promise<AdminAuditResponse> {
  const queryParams = new URLSearchParams();
  if (params.query) queryParams.set('query', params.query);
  if (params.sessionId) queryParams.set('sessionId', params.sessionId);
  if (params.eventType) queryParams.set('eventType', params.eventType);
  if (typeof params.limit === 'number') {
    queryParams.set('limit', String(params.limit));
  }
  const suffix = queryParams.toString();
  return requestJson<AdminAuditResponse>(
    suffix ? `/api/admin/audit?${suffix}` : '/api/admin/audit',
    { token },
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

export async function uploadSkillZip(
  token: string,
  file: File,
): Promise<AdminSkillsResponse> {
  const response = await fetch('/api/admin/skills/upload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token.trim()}`,
      'Content-Type': 'application/zip',
    },
    body: file,
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
  };
  if (!response.ok) {
    const message =
      payload.error || `${response.status} ${response.statusText}`;
    if (response.status === 401) {
      dispatchAuthRequired(message);
    }
    throw new Error(message);
  }
  return payload as AdminSkillsResponse;
}

export function fetchPlugins(token: string): Promise<AdminPluginsResponse> {
  return requestJson<AdminPluginsResponse>('/api/admin/plugins', { token });
}

export function fetchAdaptiveSkillHealth(
  token: string,
): Promise<AdminAdaptiveSkillHealthResponse> {
  return requestJson<AdminAdaptiveSkillHealthResponse>('/api/skills/health', {
    token,
  });
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
