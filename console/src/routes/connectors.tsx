import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  fetchConnectors,
  logoutConnector,
  saveHybridAIConnectorKey,
  startConnectorOAuth,
} from '../api/client';
import type { AdminConnector, AdminConnectorId } from '../api/types';
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
import { HybridClaw } from '../components/icons';
import {
  GoogleLogo,
  HybridAILogo,
  MicrosoftLogo,
} from '../components/icons/providers';
import { Input } from '../components/input';
import { Textarea } from '../components/textarea';
import { useToast } from '../components/toast';
import { BooleanPill, PageHeader } from '../components/ui';
import { cx } from '../lib/cx';
import { getErrorMessage } from '../lib/error-message';
import styles from './connectors.module.css';

type OAuthConnectorId = Exclude<AdminConnectorId, 'hybridai'>;

interface OAuthDraft {
  account: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
}

const OAUTH_POLL_INTERVAL_MS = 2_000;
const OAUTH_POLL_TIMEOUT_MS = 5 * 60_000;

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

function connectorMarkClass(connector: AdminConnector): string {
  return cx(
    styles.connectorMark,
    connector.id === 'hybridai' && styles.connectorMarkHybridai,
    connector.id === 'google' && styles.connectorMarkGoogle,
    connector.id === 'microsoft365' && styles.connectorMarkMicrosoft365,
  );
}

function ConnectorLogo({ connector }: { connector: AdminConnector }) {
  if (connector.id === 'hybridai') {
    return <HybridAILogo width={24} height={24} />;
  }
  if (connector.id === 'google') {
    return <GoogleLogo width={24} height={24} />;
  }
  return <MicrosoftLogo width={24} height={24} />;
}

function oauthDraftFromConnector(connector: AdminConnector): OAuthDraft {
  return {
    account: connector.account || '',
    tenantId: connector.tenantId || '',
    clientId: '',
    clientSecret: '',
    scopes: connector.scopes.join(' '),
  };
}

function isOAuthConnectorId(
  value: AdminConnectorId,
): value is OAuthConnectorId {
  return value === 'google' || value === 'microsoft365';
}

function routeLabel(connector: AdminConnector): string {
  if (connector.id === 'hybridai') return 'built in';
  return connector.routesConfigured ? 'configured' : 'missing';
}

export function ConnectorsPage() {
  const auth = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [hybridKeyOpen, setHybridKeyOpen] = useState(false);
  const [hybridApiKey, setHybridApiKey] = useState('');
  const [oauthTargetId, setOauthTargetId] = useState<OAuthConnectorId | null>(
    null,
  );
  const [oauthDraft, setOauthDraft] = useState<OAuthDraft>({
    account: '',
    tenantId: '',
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
    mutationFn: async () => {
      if (!oauthTargetId) throw new Error('Select a connector first.');
      const started = await startConnectorOAuth(auth.token, {
        provider: oauthTargetId,
        account: oauthDraft.account,
        tenantId: oauthDraft.tenantId,
        clientId: oauthDraft.clientId,
        clientSecret: oauthDraft.clientSecret,
        scopes: oauthDraft.scopes,
      });
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
          (entry) => entry.id === oauthTargetId,
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

  const connectors = connectorsQuery.data?.connectors || [];
  const oauthTarget =
    connectors.find((connector) => connector.id === oauthTargetId) || null;
  const isMicrosoftOAuthTarget = oauthTargetId === 'microsoft365';
  const microsoftNeedsClientSetup =
    isMicrosoftOAuthTarget && oauthTarget?.clientConfigured === false;
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
    (microsoftNeedsClientSetup && !oauthDraft.clientId.trim()) ||
    googleNeedsAccount ||
    googleNeedsClientId ||
    googleNeedsClientSecret;

  const openOAuthDialog = (connector: AdminConnector) => {
    if (!isOAuthConnectorId(connector.id)) return;
    setOauthDraft(oauthDraftFromConnector(connector));
    setOauthTargetId(connector.id);
  };

  if (connectorsQuery.isPending) {
    return (
      <div className="page-stack">
        <PageHeader description="Prebuilt account and workspace integrations" />
        <div className="empty-state">Loading connectors...</div>
      </div>
    );
  }

  if (connectorsQuery.isError) {
    return (
      <div className="page-stack">
        <PageHeader description="Prebuilt account and workspace integrations" />
        <div className="empty-state">
          Failed to load connectors: {getErrorMessage(connectorsQuery.error)}
        </div>
      </div>
    );
  }

  return (
    <div className="page-stack">
      <PageHeader description="Prebuilt account and workspace integrations" />

      <div className={styles.connectorGrid}>
        {connectors.map((connector) => (
          <Card key={connector.id} className={styles.connectorCard}>
            <CardHeader>
              <div className={styles.connectorHead}>
                <span className={connectorMarkClass(connector)}>
                  <ConnectorLogo connector={connector} />
                </span>
                <div>
                  <div className={styles.connectorTitleRow}>
                    <CardTitle className={styles.connectorTitle}>
                      {connector.name}
                    </CardTitle>
                    <BooleanPill
                      value={stateIsConnected(connector)}
                      trueLabel="connected"
                      falseLabel={stateLabel(connector)}
                      falseTone={
                        connector.state === 'needs_setup' ? 'danger' : 'default'
                      }
                    />
                  </div>
                  <p className={styles.connectorDescription}>
                    {connector.description}
                  </p>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className={styles.connectorFacts}>
                <div className={styles.connectorFact}>
                  <span>Account</span>
                  <strong>{connector.account || 'not set'}</strong>
                </div>
                <div className={styles.connectorFact}>
                  <span>Auth</span>
                  <strong>{connector.authKind}</strong>
                </div>
                {connector.tenantId ? (
                  <div className={styles.connectorFact}>
                    <span>Tenant</span>
                    <strong>{connector.tenantId}</strong>
                  </div>
                ) : null}
                <div className={styles.connectorFact}>
                  <span>Routes</span>
                  <strong>{routeLabel(connector)}</strong>
                </div>
                <div className={styles.connectorFact}>
                  <span>Status</span>
                  <strong>{connector.detail}</strong>
                </div>
              </div>

              {connector.state === 'needs_setup' ? (
                <div className={styles.setupList}>
                  {connector.setupSecretNames.map((name) => (
                    <code key={name} className={styles.setupSecret}>
                      {name}
                    </code>
                  ))}
                </div>
              ) : null}

              <div className={styles.connectorActions}>
                {connector.id === 'hybridai' ? (
                  <>
                    <Button
                      type="button"
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
                        variant="ghost"
                        loading={logoutMutation.isPending}
                        disabled={logoutMutation.isPending}
                        onClick={() => logoutMutation.mutate(connector.id)}
                      >
                        Disconnect
                      </Button>
                    ) : null}
                  </>
                ) : (
                  <>
                    <Button
                      type="button"
                      onClick={() => openOAuthDialog(connector)}
                    >
                      {connector.state === 'connected'
                        ? 'Reconnect'
                        : 'Connect'}
                    </Button>
                    {connector.state === 'connected' ? (
                      <Button
                        type="button"
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
              </div>
            </CardContent>
          </Card>
        ))}
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
              {isMicrosoftOAuthTarget
                ? 'Sign in with your work account'
                : oauthTarget
                  ? `Connect ${oauthTarget.name}`
                  : 'Connect'}
            </DialogTitle>
            <DialogDescription>
              {isMicrosoftOAuthTarget
                ? 'Sign in with your Microsoft 365 work or school account. Personal Microsoft accounts are not supported.'
                : oauthMutation.isPending
                  ? 'Waiting for authorization in the browser.'
                  : 'Leave stored app credentials blank to reuse them.'}
            </DialogDescription>
          </DialogHeader>

          {isMicrosoftOAuthTarget ? (
            <div className={styles.microsoftDialog}>
              <div className={styles.oauthBridge} aria-hidden="true">
                <span
                  className={cx(
                    styles.oauthBridgeMark,
                    styles.connectorMarkMicrosoft365,
                  )}
                >
                  <MicrosoftLogo width={28} height={28} />
                </span>
                <span className={styles.oauthBridgeLine} />
                <span
                  className={cx(
                    styles.oauthBridgeMark,
                    styles.oauthBridgeMarkHybridClaw,
                  )}
                >
                  <HybridClaw width={28} height={28} />
                </span>
              </div>

              {oauthMutation.isPending ? (
                <div className={styles.microsoftCopy}>
                  <p>Complete the Microsoft sign-in in the new browser tab.</p>
                  {pendingAuthUrl ? (
                    <a
                      className={styles.pendingLink}
                      href={pendingAuthUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Reopen Microsoft sign-in
                    </a>
                  ) : null}
                </div>
              ) : (
                <div className={styles.microsoftCopy}>
                  <p>
                    Connect SharePoint, OneDrive, Outlook, Teams, calendar, and
                    chat data to HybridClaw through Microsoft Graph.
                  </p>
                  <p>
                    If you are the Microsoft Entra admin, approve access during
                    sign-in. Otherwise your admin may need to approve it first.
                  </p>
                </div>
              )}

              {microsoftNeedsClientSetup ? (
                <div className={styles.microsoftSetup}>
                  <div>
                    <strong>One-time Entra app setup</strong>
                    <p>
                      Add the HybridClaw Microsoft app client ID here once to
                      enable the simple sign-in flow on this gateway.
                    </p>
                  </div>
                  <Field>
                    <FieldLabel>Microsoft app client ID</FieldLabel>
                    <Input
                      value={oauthDraft.clientId}
                      onChange={(event) =>
                        setOauthDraft((current) => ({
                          ...current,
                          clientId: event.target.value,
                        }))
                      }
                      placeholder="00000000-0000-0000-0000-000000000000"
                    />
                  </Field>
                </div>
              ) : null}
            </div>
          ) : (
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
          )}

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
              onClick={() => oauthMutation.mutate()}
            >
              {oauthMutation.isPending
                ? 'Waiting...'
                : isMicrosoftOAuthTarget
                  ? 'Continue'
                  : 'Connect'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
