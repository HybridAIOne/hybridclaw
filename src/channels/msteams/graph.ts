interface GraphTokenResponse {
  access_token?: string;
  expires_in?: number;
}

interface GraphCollectionResponse<T> {
  value?: T[];
}

export interface MSTeamsGraphTeam {
  id: string;
  displayName: string;
  description?: string;
}

export interface MSTeamsGraphChannel {
  id: string;
  displayName: string;
  description?: string;
  membershipType?: string;
}

export interface MSTeamsGraphUser {
  id: string;
  displayName: string;
  userPrincipalName?: string;
  mail?: string;
}

export interface MSTeamsGraphClientOptions {
  appId: string;
  appPassword: string;
  tenantId: string;
}

export class MSTeamsGraphClient {
  private readonly appId: string;
  private readonly appPassword: string;
  private readonly tenantId: string;
  private token = '';
  private tokenExpiresAt = 0;

  constructor(options: MSTeamsGraphClientOptions) {
    this.appId = options.appId.trim();
    this.appPassword = options.appPassword.trim();
    this.tenantId = options.tenantId.trim();
  }

  async listJoinedTeams(): Promise<MSTeamsGraphTeam[]> {
    const payload =
      await this.request<GraphCollectionResponse<MSTeamsGraphTeam>>(
        '/me/joinedTeams',
      );
    return Array.isArray(payload.value) ? payload.value : [];
  }

  async listTeamChannels(teamId: string): Promise<MSTeamsGraphChannel[]> {
    const payload = await this.request<
      GraphCollectionResponse<MSTeamsGraphChannel>
    >(`/teams/${encodeURIComponent(teamId)}/channels`);
    return Array.isArray(payload.value) ? payload.value : [];
  }

  async lookupUsers(query: string): Promise<MSTeamsGraphUser[]> {
    const normalized = query.trim().replace(/'/g, "''");
    if (!normalized) return [];
    const filter = encodeURIComponent(
      `startsWith(displayName,'${normalized}') or startsWith(userPrincipalName,'${normalized}')`,
    );
    const payload = await this.request<
      GraphCollectionResponse<MSTeamsGraphUser>
    >(
      `/users?$top=10&$select=id,displayName,userPrincipalName,mail&$filter=${filter}`,
    );
    return Array.isArray(payload.value) ? payload.value : [];
  }

  private async request<T>(pathname: string): Promise<T> {
    const token = await this.getAccessToken();
    const response = await fetch(
      `https://graph.microsoft.com/v1.0${pathname}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      },
    );
    if (!response.ok) {
      throw new Error(
        `Microsoft Graph request failed (${response.status} ${response.statusText})`,
      );
    }
    return (await response.json()) as T;
  }

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.token && now < this.tokenExpiresAt - 60_000) {
      return this.token;
    }

    const form = new URLSearchParams({
      client_id: this.appId,
      client_secret: this.appPassword,
      grant_type: 'client_credentials',
      scope: 'https://graph.microsoft.com/.default',
    });
    const response = await fetch(
      `https://login.microsoftonline.com/${encodeURIComponent(
        this.tenantId,
      )}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Microsoft Graph token request failed (${response.status} ${response.statusText})`,
      );
    }
    const payload = (await response.json()) as GraphTokenResponse;
    const accessToken = String(payload.access_token || '').trim();
    if (!accessToken) {
      throw new Error(
        'Microsoft Graph token response did not include access_token.',
      );
    }
    this.token = accessToken;
    this.tokenExpiresAt =
      now + Math.max(60, Number(payload.expires_in || 3_600)) * 1_000;
    return this.token;
  }
}
