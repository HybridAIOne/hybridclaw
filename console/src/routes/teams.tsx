import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  downloadMSTeamsOrgManifest,
  fetchConfig,
  fetchMSTeamsTabStatus,
  saveConfig,
} from '../api/client';
import type { AdminConfig } from '../api/types';
import { useAuth } from '../auth';
import { Button } from '../components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/card';
import { Input } from '../components/input';
import { Switch } from '../components/switch';
import { Textarea } from '../components/textarea';
import { useToast } from '../components/toast';
import { PageHeader } from '../components/ui';
import { getErrorMessage } from '../lib/error-message';
import styles from './teams.module.css';

function splitAllowFrom(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function defaultTeamsTabConfig(config: AdminConfig['msteams']) {
  return (
    config.tab ?? {
      enabled: false,
      ssoAppId: '',
      appIdUri: '',
      allowFrom: [],
    }
  );
}

function StatusPill(props: { ok: boolean }) {
  return (
    <span className={props.ok ? styles.pillOk : styles.pill}>
      {props.ok ? 'Ready' : 'Missing'}
    </span>
  );
}

function needsPublicHttpsOrigin(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol !== 'https:' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === 'localhost' ||
      url.hostname === '::1'
    );
  } catch {
    return true;
  }
}

function CopyValue(props: { label: string; value: string }) {
  const toast = useToast();
  return (
    <div className={styles.copyField}>
      <span className={styles.copyLabel}>{props.label}</span>
      <div className={styles.row}>
        <span className={styles.value}>{props.value || 'Not configured'}</span>
        <Button
          variant="outline"
          size="sm"
          disabled={!props.value}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(props.value);
              toast.success(`${props.label} copied.`);
            } catch {
              toast.error('Could not copy value.');
            }
          }}
        >
          Copy
        </Button>
      </div>
    </div>
  );
}

export function TeamsPage() {
  const { token } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [enabled, setEnabled] = useState(false);
  const [ssoAppId, setSsoAppId] = useState('');
  const [appIdUri, setAppIdUri] = useState('');
  const [allowFrom, setAllowFrom] = useState('');
  const [testMessage, setTestMessage] = useState('');
  const [downloading, setDownloading] = useState(false);

  const configQuery = useQuery({
    queryKey: ['config', token],
    queryFn: () => fetchConfig(token),
    retry: false,
  });
  const statusQuery = useQuery({
    queryKey: ['msteams-tab-status', token],
    queryFn: () => fetchMSTeamsTabStatus(token),
    retry: false,
  });

  useEffect(() => {
    const config = configQuery.data?.config.msteams;
    if (!config) return;
    const tab = defaultTeamsTabConfig(config);
    setEnabled(tab.enabled);
    setSsoAppId(tab.ssoAppId || config.appId || '');
    setAppIdUri(tab.appIdUri || statusQuery.data?.appIdUri || '');
    setAllowFrom(tab.allowFrom.join('\n'));
  }, [configQuery.data, statusQuery.data?.appIdUri]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const current = configQuery.data?.config;
      if (!current) throw new Error('Runtime config is not loaded.');
      return saveConfig(token, {
        ...current,
        msteams: {
          ...current.msteams,
          tab: {
            enabled,
            ssoAppId: ssoAppId.trim(),
            appIdUri: appIdUri.trim(),
            allowFrom: splitAllowFrom(allowFrom),
          },
        },
      });
    },
    onSuccess: async (payload) => {
      queryClient.setQueryData(['config', token], payload);
      await statusQuery.refetch();
      toast.success('Teams settings saved.');
    },
    onError: (error) => {
      toast.error(`Save failed: ${getErrorMessage(error)}`);
    },
  });

  async function runTest() {
    const result = await statusQuery.refetch();
    const status = result.data;
    if (!status) {
      setTestMessage('Status check failed.');
      return;
    }
    const missing = [
      status.tenantId ? '' : 'tenant ID',
      status.ssoAppId ? '' : 'SSO app ID',
      status.appIdUri ? '' : 'App ID URI',
      status.enabled ? '' : 'enabled tab SSO',
    ].filter(Boolean);
    setTestMessage(
      missing.length > 0
        ? `Missing ${missing.join(', ')}.`
        : 'Configuration values are present.',
    );
  }

  async function downloadOrgManifest() {
    if (downloading) return;
    setDownloading(true);
    try {
      const blob = await downloadMSTeamsOrgManifest(token);
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = 'hybridclaw-teams-app.zip';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (error) {
      toast.error(`Download failed: ${getErrorMessage(error)}`);
    } finally {
      setDownloading(false);
    }
  }

  const status = statusQuery.data;
  const showPublicOriginWarning = needsPublicHttpsOrigin(status?.publicOrigin);

  if (configQuery.isLoading) {
    return <div className="empty-state">Loading Teams app setup…</div>;
  }

  if (configQuery.isError) {
    return (
      <div className="empty-state">
        Failed to load Teams app setup: {getErrorMessage(configQuery.error)}
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <h1>Teams App Setup</h1>
      <PageHeader description="Microsoft Teams tab sharing" />

      <div className={styles.grid}>
        <Card>
          <CardHeader>
            <CardTitle>Detect</CardTitle>
            <CardDescription>Gateway and Entra values</CardDescription>
          </CardHeader>
          <CardContent className={styles.stack}>
            <CopyValue
              label="Public origin"
              value={status?.publicOrigin || ''}
            />
            <CopyValue label="Tenant ID" value={status?.tenantId || ''} />
            <CopyValue
              label="App ID URI"
              value={status?.appIdUri || appIdUri}
            />
            <CopyValue
              label="Browser redirect URI"
              value={status?.browserRedirectUri || ''}
            />
            <CopyValue
              label="Teams desktop and mobile client ID"
              value={status?.teamsClientIds.desktopMobile || ''}
            />
            <CopyValue
              label="Teams web client ID"
              value={status?.teamsClientIds.web || ''}
            />
            {showPublicOriginWarning ? (
              <p className={styles.warning}>
                Localhost is only for local browser testing. Teams requires a
                public HTTPS URL for this gateway before the app package or tab
                links will work.
              </p>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Configure</CardTitle>
            <CardDescription>Tab SSO runtime settings</CardDescription>
          </CardHeader>
          <CardContent className={styles.stack}>
            <label className={styles.row}>
              <span>Enable tab SSO</span>
              <Switch checked={enabled} onCheckedChange={setEnabled} />
            </label>
            <Input
              value={ssoAppId}
              placeholder="SSO app ID"
              onChange={(event) => setSsoAppId(event.target.value)}
            />
            <Input
              value={appIdUri}
              placeholder="api://domain/app-id"
              onChange={(event) => setAppIdUri(event.target.value)}
            />
            <Textarea
              value={allowFrom}
              placeholder="Optional UPN or oid allowlist"
              rows={4}
              onChange={(event) => setAllowFrom(event.target.value)}
            />
            <div className={styles.actions}>
              <Button
                loading={saveMutation.isPending}
                onClick={() => saveMutation.mutate()}
              >
                Save Teams settings
              </Button>
              <Button variant="outline" onClick={runTest}>
                Test
              </Button>
            </div>
            {testMessage ? <p className={styles.muted}>{testMessage}</p> : null}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Verify</CardTitle>
          <CardDescription>Required values for Teams SSO</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className={styles.checkList}>
            <li className={styles.checkItem}>
              <span>Tab SSO enabled</span>
              <StatusPill ok={status?.enabled === true} />
            </li>
            <li className={styles.checkItem}>
              <span>Tenant ID</span>
              <StatusPill ok={Boolean(status?.tenantId)} />
            </li>
            <li className={styles.checkItem}>
              <span>SSO app ID</span>
              <StatusPill ok={Boolean(status?.ssoAppId)} />
            </li>
            <li className={styles.checkItem}>
              <span>App ID URI</span>
              <StatusPill ok={Boolean(status?.appIdUri)} />
            </li>
            <li className={styles.checkItem}>
              <span>Scope</span>
              <StatusPill ok={status?.scope === 'access_as_user'} />
            </li>
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Install</CardTitle>
          <CardDescription>Org app package</CardDescription>
        </CardHeader>
        <CardContent className={styles.stack}>
          <p className={styles.muted}>
            Upload this package to the Teams org catalog after the Entra app is
            configured.
          </p>
          <div>
            <Button
              loading={downloading}
              disabled={!status?.enabled}
              onClick={downloadOrgManifest}
            >
              Download org app
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
