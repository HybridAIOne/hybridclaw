import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  fetchConnectors,
  logoutConnector,
  saveHybridAIConnectorKey,
  startConnectorOAuth,
  testConnector,
} from '../api/client';
import type { AdminConnector, AdminConnectorId } from '../api/types';
import { useAuth } from '../auth';
import { Button } from '../components/button';
import { Card, CardHeader, CardTitle } from '../components/card';
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
import {
  GitHubLogo,
  GoogleLogo,
  HybridAILogo,
  MicrosoftLogo,
} from '../components/icons/providers';
import { Input } from '../components/input';
import { Textarea } from '../components/textarea';
import { useToast } from '../components/toast';
import { BooleanPill } from '../components/ui';
import { cx } from '../lib/cx';
import { getErrorMessage } from '../lib/error-message';
import styles from './connectors.module.css';

type LocalOAuthConnectorId = Extract<AdminConnectorId, 'google'>;
type OAuthConnectorId = Exclude<AdminConnectorId, 'hybridai'>;
type PlatformConnectorId = Extract<AdminConnectorId, 'github' | 'microsoft365'>;

interface OAuthDraft {
  account: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
}

interface OAuthStartPayload {
  provider: OAuthConnectorId;
  account?: string;
  clientId?: string;
  clientSecret?: string;
  scopes?: string;
}

const OAUTH_POLL_INTERVAL_MS = 2_000;
const OAUTH_POLL_TIMEOUT_MS = 5 * 60_000;
const PLATFORM_CONNECTORS = new Set<AdminConnectorId>([
  'github',
  'microsoft365',
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stateLabel(connector: AdminConnector): string {
  if (connector.state === 'connected') return 'connected';
  if (connector.state === 'needs_setup') return 'setup';
  return 'not connected';
}

function stateIsConnected(connector: AdminConnector): boolean {
  return connector.state === 'connected';
}

function connectorIsPlatform(
  connector: AdminConnector,
): connector is AdminConnector & { id: PlatformConnectorId } {
  return PLATFORM_CONNECTORS.has(connector.id);
}

function connectorMarkClass(connector: AdminConnector): string {
  return cx(
    styles.connectorMark,
    connector.id === 'hybridai' && styles.connectorMarkHybridai,
    connector.id === 'github' && styles.connectorMarkGithub,
    connector.id === 'google' && styles.connectorMarkGoogle,
    connector.id === 'microsoft365' && styles.connectorMarkMicrosoft365,
  );
}

function ConnectorLogo({ connector }: { connector: AdminConnector }) {
  if (connector.id === 'hybridai') {
    return <HybridAILogo width={24} height={24} />;
  }
  if (connector.id === 'github') {
    return <GitHubLogo width={24} height={24} />;
  }
  if (connector.id === 'google') {
    return <GoogleLogo width={24} height={24} />;
  }
  return <MicrosoftLogo width={24} height={24} />;
}

function oauthDraftFromConnector(connector: AdminConnector): OAuthDraft {
  return {
    account: connector.account || '',
    clientId: '',
    clientSecret: '',
    scopes: connector.scopes.join(' '),
  };
}

function isOAuthConnectorId(
  value: AdminConnectorId,
): value is LocalOAuthConnectorId {
  return value === 'google';
}

function isPlatformConnectorId(
  value: string | null,
): value is PlatformConnectorId {
  return value === 'github' || value === 'microsoft365';
}

function platformConnectorName(provider: PlatformConnectorId): string {
  return provider === 'github' ? 'GitHub' : 'Microsoft 365';
}

function canUseStoredGoogleOAuth(connector: AdminConnector): boolean {
  return (
    connector.id === 'google' &&
    Boolean(connector.account) &&
    connector.clientConfigured &&
    connector.clientSecretConfigured
  );
}

function oauthPayloadFromDraft(
  provider: LocalOAuthConnectorId,
  draft: OAuthDraft,
): OAuthStartPayload {
  return {
    provider,
    account: draft.account,
    clientId: draft.clientId,
    clientSecret: draft.clientSecret,
    scopes: draft.scopes,
  };
}

export function ConnectorsPage() {
  const auth = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [hybridKeyOpen, setHybridKeyOpen] = useState(false);
  const [hybridApiKey, setHybridApiKey] = useState('');
  const [oauthTargetId, setOauthTargetId] =
    useState<LocalOAuthConnectorId | null>(null);
  const [platformConnectedIds, setPlatformConnectedIds] = useState<
    Set<PlatformConnectorId>
  >(() => {
    if (typeof window === 'undefined') return new Set();
    const params = new URLSearchParams(window.location.search);
    const connected = params.get('connected');
    return isPlatformConnectorId(connected) ? new Set([connected]) : new Set();
  });
  const [oauthDraft, setOauthDraft] = useState<OAuthDraft>({
    account: '',
    clientId: '',
    clientSecret: '',
    scopes: '',
  });
  const [pendingAuthUrl, setPendingAuthUrl] = useState<string | null>(null);

  const connectorsQuery = useQuery({
    queryKey: ['admin', 'connectors', auth.token],
    queryFn: () => fetchConnectors(auth.token),
    retry: false,
  });

  const setConnectorsData = (
    data: Awaited<ReturnType<typeof fetchConnectors>>,
  ) => queryClient.setQueryData(['admin', 'connectors', auth.token], data);

  const hybridKeyMutation = useMutation({
    mutationFn: () => saveHybridAIConnectorKey(auth.token, hybridApiKey),
    onSuccess: (payload) => {
      setConnectorsData(payload);
      setHybridApiKey('');
      setHybridKeyOpen(false);
      toast.success('HybridAI connected.');
    },
    onError: (error) => {
      toast.error('HybridAI connection failed', getErrorMessage(error));
    },
  });

  const oauthMutation = useMutation({
    mutationFn: async (payload: OAuthStartPayload) => {
      const started = await startConnectorOAuth(auth.token, payload);
      if (isPlatformConnectorId(started.provider)) {
        window.open(started.authorizationUrl, '_self');
        return platformConnectorName(started.provider);
      }

      setPendingAuthUrl(started.authorizationUrl);
      window.open(started.authorizationUrl, '_blank', 'noopener');

      const deadline =
        Date.now() +
        Math.max(
          OAUTH_POLL_INTERVAL_MS,
          Math.min(OAUTH_POLL_TIMEOUT_MS, started.expiresAt - Date.now()),
        );
      while (Date.now() < deadline) {
        await sleep(OAUTH_POLL_INTERVAL_MS);
        const payload = await fetchConnectors(auth.token);
        setConnectorsData(payload);
        const connector = payload.connectors.find(
          (entry) => entry.id === started.provider,
        );
        if (connector?.state === 'connected') return connector.name;
      }
      throw new Error(
        'Timed out waiting for authorization. Complete the login in the opened tab and try again.',
      );
    },
    onSuccess: (name) => {
      setPendingAuthUrl(null);
      setOauthTargetId(null);
      toast.success(`${name} connected.`);
    },
    onError: (error) => {
      setPendingAuthUrl(null);
      toast.error('OAuth connection failed', getErrorMessage(error));
    },
  });

  const logoutMutation = useMutation({
    mutationFn: (provider: AdminConnectorId) =>
      logoutConnector(auth.token, provider),
    onSuccess: (payload) => {
      setConnectorsData(payload);
      toast.success('Connector credentials cleared.');
    },
    onError: (error) => {
      toast.error('Disconnect failed', getErrorMessage(error));
    },
  });

  const testMutation = useMutation({
    mutationFn: (provider: AdminConnectorId) =>
      testConnector(auth.token, provider),
    onSuccess: (result) => {
      if (result.ok) {
        toast.success(`${result.name} test passed.`, result.message);
        queryClient.invalidateQueries({
          queryKey: ['admin', 'connectors', auth.token],
        });
        return;
      }
      toast.error(`${result.name} test failed.`, result.message);
    },
    onError: (error) => {
      toast.error('Connector test failed', getErrorMessage(error));
    },
  });

  const connectors = connectorsQuery.data?.connectors || [];
  const oauthTarget =
    connectors.find((connector) => connector.id === oauthTargetId) || null;
  const googleNeedsAccount =
    oauthTargetId === 'google' && !oauthDraft.account.trim();
  const googleNeedsClientId =
    oauthTargetId === 'google' &&
    !oauthTarget?.clientConfigured &&
    !oauthDraft.clientId.trim();
  const googleNeedsClientSecret =
    oauthTargetId === 'google' &&
    !oauthTarget?.clientSecretConfigured &&
    !oauthDraft.clientSecret.trim();
  const oauthSubmitDisabled =
    oauthMutation.isPending ||
    !oauthTargetId ||
    googleNeedsAccount ||
    googleNeedsClientId ||
    googleNeedsClientSecret;

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get('connected');
    const connectError = params.get('connect_error');
    if (!isPlatformConnectorId(connected) && !connectError) return;

    if (isPlatformConnectorId(connected)) {
      setPlatformConnectedIds((current) => {
        const next = new Set(current);
        next.add(connected);
        return next;
      });
      toast.success(`${platformConnectorName(connected)} connected.`);
    } else {
      toast.error('Connector connection failed.');
    }

    const url = new URL(window.location.href);
    url.searchParams.delete('connected');
    url.searchParams.delete('connect_error');
    window.history.replaceState(null, '', `${url.pathname}${url.search}`);
  }, [toast]);

  const openPlatformConnector = (connector: AdminConnector) => {
    if (!connector.loginUrl) {
      toast.error(`${connector.name} connection is not available.`);
      return;
    }
    const url = new URL(connector.loginUrl);
    url.searchParams.delete('connect');
    url.searchParams.delete('return_to');
    url.hash = connector.id;
    window.open(url.toString(), '_self');
  };

  const openOAuthDialog = (connector: AdminConnector) => {
    if (!isOAuthConnectorId(connector.id)) return;
    if (canUseStoredGoogleOAuth(connector)) {
      oauthMutation.mutate({ provider: 'google' });
      return;
    }
    setOauthDraft(oauthDraftFromConnector(connector));
    setOauthTargetId(connector.id);
  };

  if (connectorsQuery.isPending) {
    return (
      <div className="page-stack">
        <div className="empty-state">Loading connectors...</div>
      </div>
    );
  }

  if (connectorsQuery.isError) {
    return (
      <div className="page-stack">
        <div className="empty-state">
          Failed to load connectors: {getErrorMessage(connectorsQuery.error)}
        </div>
      </div>
    );
  }

  return (
    <div className="page-stack">
      <div className={styles.connectorGrid}>
        {connectors.map((connector) => {
          const isPlatform = connectorIsPlatform(connector);
          const isConnected =
            stateIsConnected(connector) ||
            (isPlatform && platformConnectedIds.has(connector.id));

          return (
            <Card key={connector.id} className={styles.connectorCard}>
              <CardHeader>
                <div className={styles.connectorHead}>
                  <span className={connectorMarkClass(connector)}>
                    <ConnectorLogo connector={connector} />
                  </span>
                  <div className={styles.connectorText}>
                    <div className={styles.connectorTitleRow}>
                      <CardTitle className={styles.connectorTitle}>
                        {connector.name}
                      </CardTitle>
                      <BooleanPill
                        value={isConnected}
                        trueLabel="connected"
                        falseLabel={stateLabel(connector)}
                        falseTone={
                          connector.state === 'needs_setup'
                            ? 'danger'
                            : 'default'
                        }
                      />
                    </div>
                    <p className={styles.connectorDescription}>
                      {connector.description}
                    </p>
                  </div>
                </div>
              </CardHeader>
              <div className={styles.connectorActions}>
                {connector.id === 'hybridai' ? (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => {
                        if (connector.loginUrl) {
                          window.open(connector.loginUrl, '_blank', 'noopener');
                        }
                        setHybridKeyOpen(true);
                      }}
                    >
                      {connector.state === 'connected'
                        ? 'Rotate key'
                        : 'Connect'}
                    </Button>
                    {connector.state === 'connected' ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        loading={logoutMutation.isPending}
                        disabled={logoutMutation.isPending}
                        onClick={() => logoutMutation.mutate(connector.id)}
                      >
                        Disconnect
                      </Button>
                    ) : null}
                  </>
                ) : isPlatform ? (
                  <Button
                    type="button"
                    size="sm"
                    loading={
                      oauthMutation.isPending &&
                      oauthMutation.variables?.provider === connector.id
                    }
                    disabled={oauthMutation.isPending}
                    aria-label={`${isConnected ? 'Manage' : 'Connect'} ${
                      connector.name
                    }`}
                    onClick={() => {
                      if (isConnected) {
                        openPlatformConnector(connector);
                        return;
                      }
                      oauthMutation.mutate({ provider: connector.id });
                    }}
                  >
                    {isConnected ? 'Manage' : 'Connect'}
                  </Button>
                ) : (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      loading={
                        oauthMutation.isPending &&
                        oauthMutation.variables?.provider === connector.id
                      }
                      disabled={oauthMutation.isPending}
                      onClick={() => openOAuthDialog(connector)}
                    >
                      {connector.state === 'connected'
                        ? 'Reconnect'
                        : 'Connect'}
                    </Button>
                    {connector.state === 'connected' ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        loading={logoutMutation.isPending}
                        disabled={logoutMutation.isPending}
                        onClick={() => logoutMutation.mutate(connector.id)}
                      >
                        Disconnect
                      </Button>
                    ) : null}
                  </>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  loading={
                    testMutation.isPending &&
                    testMutation.variables === connector.id
                  }
                  disabled={testMutation.isPending}
                  aria-label={`Test ${connector.name}`}
                  onClick={() => testMutation.mutate(connector.id)}
                >
                  Test
                </Button>
              </div>
            </Card>
          );
        })}
      </div>

      <Dialog open={hybridKeyOpen} onOpenChange={setHybridKeyOpen}>
        <DialogContent size="default">
          <DialogHeader>
            <DialogTitle>HybridAI API Key</DialogTitle>
            <DialogDescription>Paste the key from HybridAI.</DialogDescription>
          </DialogHeader>
          <div className={styles.dialogForm}>
            <Field>
              <FieldLabel>API key</FieldLabel>
              <Input
                type="password"
                autoComplete="off"
                value={hybridApiKey}
                onChange={(event) => setHybridApiKey(event.target.value)}
                placeholder="hai-..."
              />
            </Field>
          </div>
          <DialogFooter>
            <DialogClose className="ghost-button">Cancel</DialogClose>
            <Button
              type="button"
              loading={hybridKeyMutation.isPending}
              disabled={!hybridApiKey.trim() || hybridKeyMutation.isPending}
              onClick={() => hybridKeyMutation.mutate()}
            >
              Save key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={oauthTargetId !== null}
        onOpenChange={(open) => {
          if (!open && !oauthMutation.isPending) {
            setOauthTargetId(null);
            setPendingAuthUrl(null);
          }
        }}
      >
        <DialogContent
          size="lg"
          preventCloseOnOutsideClick={oauthMutation.isPending}
        >
          <DialogHeader>
            <DialogTitle>
              {oauthTarget ? `Connect ${oauthTarget.name}` : 'Connect'}
            </DialogTitle>
            <DialogDescription>
              {oauthMutation.isPending
                ? 'Waiting for authorization in the browser.'
                : 'Leave stored app credentials blank to reuse them.'}
            </DialogDescription>
          </DialogHeader>

          <div className={styles.dialogForm}>
            <Field>
              <FieldLabel>Google account</FieldLabel>
              <Input
                value={oauthDraft.account}
                onChange={(event) =>
                  setOauthDraft((current) => ({
                    ...current,
                    account: event.target.value,
                  }))
                }
                placeholder="user@example.com"
              />
            </Field>

            <div className="field-grid">
              <Field>
                <FieldLabel>Client ID</FieldLabel>
                <Input
                  value={oauthDraft.clientId}
                  onChange={(event) =>
                    setOauthDraft((current) => ({
                      ...current,
                      clientId: event.target.value,
                    }))
                  }
                  placeholder={
                    oauthTarget?.clientConfigured
                      ? 'stored client id'
                      : 'client id'
                  }
                />
              </Field>
              <Field>
                <FieldLabel>Client secret</FieldLabel>
                <Input
                  type="password"
                  autoComplete="off"
                  value={oauthDraft.clientSecret}
                  onChange={(event) =>
                    setOauthDraft((current) => ({
                      ...current,
                      clientSecret: event.target.value,
                    }))
                  }
                  placeholder={
                    oauthTarget?.clientSecretConfigured
                      ? 'stored secret'
                      : 'client secret'
                  }
                />
              </Field>
            </div>

            <Field>
              <FieldLabel>Scopes</FieldLabel>
              <Textarea
                rows={4}
                value={oauthDraft.scopes}
                onChange={(event) =>
                  setOauthDraft((current) => ({
                    ...current,
                    scopes: event.target.value,
                  }))
                }
              />
            </Field>

            {pendingAuthUrl && oauthMutation.isPending ? (
              <a
                className={styles.pendingLink}
                href={pendingAuthUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open authorization page
              </a>
            ) : null}
          </div>

          <DialogFooter>
            <DialogClose
              className="ghost-button"
              disabled={oauthMutation.isPending}
            >
              Cancel
            </DialogClose>
            <Button
              type="button"
              loading={oauthMutation.isPending}
              disabled={oauthSubmitDisabled}
              onClick={() => {
                if (!oauthTargetId) return;
                oauthMutation.mutate(
                  oauthPayloadFromDraft(oauthTargetId, oauthDraft),
                );
              }}
            >
              {oauthMutation.isPending ? 'Waiting...' : 'Connect'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
