import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  fetchAdminAgents,
  fetchConfig,
  fetchEmailConfig,
  fetchSignalLink,
  saveConfig,
  saveDiscordWebhookTarget,
  saveSlackWebhookTarget,
  setRuntimeSecret,
  startSignalLink,
  validateToken,
} from '../api/client';
import type { AdminAgent, AdminConfig } from '../api/types';
import { useAuth } from '../auth';
import { Button } from '../components/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/card';
import { ChannelLogo } from '../components/channel-logo';
import {
  Field,
  FieldContent,
  FieldLabel,
  FieldTitle,
} from '../components/field';
import {
  Form,
  FormField,
  type UseFormControllerReturn,
  useForm,
} from '../components/form';
import { Trash } from '../components/icons';
import { Input } from '../components/input';
import { NativeSelect, NativeSelectOption } from '../components/native-select';
import { NumberField } from '../components/number-field';
import { Switch } from '../components/switch';
import { Textarea } from '../components/textarea';
import { useToast } from '../components/toast';
import { useFormMutation } from '../hooks/use-form-mutation';
import { DEFAULT_AGENT_ID } from '../lib/chat-helpers';
import { getErrorMessage } from '../lib/error-message';
import { joinStringList, parseStringList } from '../lib/format';
import {
  buildChannelCatalog,
  type ChannelKind,
  countTeams,
  countTeamsOverrides,
} from './channels-catalog';

type SecretSource = 'config' | 'env' | 'runtime-secrets' | null;
type ChannelInstructionKind = keyof AdminConfig['channelInstructions'];

function isDiscordEnabled(config: AdminConfig): boolean {
  return (
    config.discord.commandsOnly || config.discord.groupPolicy !== 'disabled'
  );
}

function isWhatsAppEnabled(config: AdminConfig): boolean {
  return (
    config.whatsapp.dmPolicy !== 'disabled' ||
    config.whatsapp.groupPolicy !== 'disabled'
  );
}

function isTelegramInboundEnabled(config: AdminConfig): boolean {
  return (
    config.telegram.dmPolicy !== 'disabled' ||
    config.telegram.groupPolicy !== 'disabled'
  );
}

function ListField(props: {
  label: string;
  value: string[];
  rows?: number;
  placeholder?: string;
  onChange: (value: string[]) => void;
}) {
  return (
    <label className="field textarea-field">
      <span>{props.label}</span>
      <Textarea
        rows={props.rows ?? 3}
        value={joinStringList(props.value)}
        onChange={(event) =>
          props.onChange(parseStringList(event.target.value))
        }
        placeholder={props.placeholder}
      />
    </label>
  );
}

type EmailAccountConfig = NonNullable<AdminConfig['email']['accounts']>[number];

function getEmailAccounts(config: AdminConfig): EmailAccountConfig[] {
  return Array.isArray(config.email.accounts) ? config.email.accounts : [];
}

function createEmailAccount(config: AdminConfig['email']): EmailAccountConfig {
  return {
    agentId: '',
    imapHost: config.imapHost,
    imapPort: config.imapPort,
    imapSecure: config.imapSecure,
    smtpHost: config.smtpHost,
    smtpPort: config.smtpPort,
    smtpSecure: config.smtpSecure,
    address: '',
    password: '',
    pollIntervalMs: config.pollIntervalMs,
    folders: [...config.folders],
    allowFrom: [...config.allowFrom],
    mediaMaxMb: config.mediaMaxMb,
  };
}

function getEmailAccountPasswordRefId(account: EmailAccountConfig): string {
  const password = account.password;
  if (password && typeof password === 'object' && password.source === 'store') {
    return password.id;
  }
  return '';
}

function setEmailAccountPasswordRefId(
  account: EmailAccountConfig,
  id: string,
): EmailAccountConfig {
  const next = { ...account };
  if (id) {
    next.password = { source: 'store', id };
  } else {
    delete next.password;
  }
  return next;
}

function formatAgentOptionLabel(agent: AdminAgent): string {
  return agent.name ? `${agent.name} (${agent.id})` : agent.id;
}

function formatDefaultEmailAgentLabel(agents: AdminAgent[]): string {
  const defaultAgent = agents.find((agent) => agent.id === DEFAULT_AGENT_ID);
  if (defaultAgent) return formatAgentOptionLabel(defaultAgent);
  return `Main Agent (${DEFAULT_AGENT_ID})`;
}

function createEmailAccountKey(): string {
  return `mailbox-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2)}`;
}

function ChannelInstructionsField(props: { kind: ChannelInstructionKind }) {
  return (
    <FormField
      name={`channelInstructions.${props.kind}`}
      render={({ field }) => (
        <Field>
          <FieldLabel>Channel instructions</FieldLabel>
          <Textarea
            rows={4}
            {...field}
            placeholder="Optional extra instructions for this channel only."
          />
        </Field>
      )}
    />
  );
}

function ManagedSecretField(props: {
  label: string;
  secretName:
    | 'DISCORD_TOKEN'
    | 'SLACK_BOT_TOKEN'
    | 'SLACK_APP_TOKEN'
    | 'TELEGRAM_BOT_TOKEN'
    | 'THREEMA_GATEWAY_SECRET'
    | 'TWILIO_AUTH_TOKEN'
    | 'EMAIL_PASSWORD'
    | 'IMESSAGE_PASSWORD';
  secretLabel: 'token' | 'password' | 'secret';
  configValue?: string;
  configured: boolean;
  source: SecretSource;
  token: string;
  onSecretSaved: () => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [nextValue, setNextValue] = useState('');
  const [hasStoredSecretOverride, setHasStoredSecretOverride] = useState(false);
  const hasExistingPassword =
    props.source !== null ||
    hasStoredSecretOverride ||
    props.configured ||
    String(props.configValue || '').trim().length > 0;
  const actionLabel = hasExistingPassword
    ? `Change ${props.secretLabel}`
    : `Set ${props.secretLabel}`;
  const toast = useToast();
  const saveSecretMutation = useMutation({
    mutationFn: async (value: string) => {
      return setRuntimeSecret(props.token, props.secretName, value);
    },
    onSuccess: () => {
      setHasStoredSecretOverride(true);
      props.onSecretSaved();
      setIsEditing(false);
      setNextValue('');
      toast.success(`${props.label} updated in encrypted runtime secrets.`);
    },
    onError: (error) => {
      toast.error('Save failed', getErrorMessage(error));
    },
  });

  return (
    <Field className="managed-secret-field">
      <FieldTitle>{props.label}</FieldTitle>
      {!isEditing ? (
        <div className="button-row">
          <Button
            className="managed-secret-action"
            variant="ghost"
            type="button"
            onClick={() => {
              saveSecretMutation.reset();
              setIsEditing(true);
              setNextValue('');
            }}
          >
            {actionLabel}
          </Button>
        </div>
      ) : null}

      {isEditing ? (
        <div className="managed-secret-editor">
          <Field>
            <FieldLabel>{`New ${props.secretLabel}`}</FieldLabel>
            <Input
              type="password"
              value={nextValue}
              autoComplete="new-password"
              onChange={(event) => setNextValue(event.target.value)}
            />
          </Field>

          <div className="button-row">
            <Button
              type="button"
              loading={saveSecretMutation.isPending}
              disabled={!nextValue.trim() || saveSecretMutation.isPending}
              onClick={() => saveSecretMutation.mutate(nextValue)}
            >
              {saveSecretMutation.isPending
                ? 'Saving...'
                : `Save ${props.secretLabel}`}
            </Button>
            <Button
              variant="ghost"
              type="button"
              disabled={saveSecretMutation.isPending}
              onClick={() => {
                saveSecretMutation.reset();
                setIsEditing(false);
                setNextValue('');
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </Field>
  );
}

function DiscordChannelEditor(props: {
  draft: AdminConfig;
  form: UseFormControllerReturn<AdminConfig>;
  tokenConfigured: boolean;
  tokenSource: SecretSource;
  token: string;
  onSecretSaved: () => void;
}) {
  return (
    <>
      <Field orientation="horizontal">
        <Switch
          checked={isDiscordEnabled(props.draft)}
          onCheckedChange={(enabled) => {
            const discord = props.draft.discord;
            const groupPolicy =
              enabled &&
              discord.groupPolicy === 'disabled' &&
              !discord.commandsOnly
                ? 'open'
                : enabled
                  ? discord.groupPolicy
                  : 'disabled';
            const commandsOnly = enabled ? discord.commandsOnly : false;
            props.form.setField('discord.groupPolicy', groupPolicy);
            props.form.setField('discord.commandsOnly', commandsOnly);
          }}
        />
        <FieldContent>
          <FieldLabel>Enabled</FieldLabel>
        </FieldContent>
      </Field>

      <ManagedSecretField
        label="Bot token"
        secretName="DISCORD_TOKEN"
        secretLabel="token"
        configured={props.tokenConfigured}
        source={props.tokenSource}
        token={props.token}
        onSecretSaved={props.onSecretSaved}
      />

      <div className="field-grid">
        <FormField
          name="discord.prefix"
          render={({ field }) => (
            <Field>
              <FieldLabel>Prefix</FieldLabel>
              <Input {...field} />
            </Field>
          )}
        />
        <FormField
          name="discord.groupPolicy"
          render={({ field }) => (
            <Field>
              <FieldLabel>Group policy</FieldLabel>
              <NativeSelect
                value={field.value as string}
                onChange={field.onChange}
              >
                <NativeSelectOption value="open">open</NativeSelectOption>
                <NativeSelectOption value="allowlist">
                  allowlist
                </NativeSelectOption>
                <NativeSelectOption value="disabled">
                  disabled
                </NativeSelectOption>
              </NativeSelect>
            </Field>
          )}
        />
      </div>

      <FormField
        name="discord.commandsOnly"
        render={({ field }) => (
          <Field orientation="horizontal">
            <Switch
              checked={Boolean(field.value)}
              onCheckedChange={field.onChange}
            />
            <FieldContent>
              <FieldLabel>Commands only</FieldLabel>
            </FieldContent>
          </Field>
        )}
      />

      <div className="field-grid">
        <FormField
          name="discord.commandMode"
          render={({ field }) => (
            <Field>
              <FieldLabel>Command mode</FieldLabel>
              <NativeSelect
                value={field.value as string}
                onChange={field.onChange}
              >
                <NativeSelectOption value="public">public</NativeSelectOption>
                <NativeSelectOption value="restricted">
                  restricted
                </NativeSelectOption>
              </NativeSelect>
            </Field>
          )}
        />
        <FormField
          name="discord.sendPolicy"
          render={({ field }) => (
            <Field>
              <FieldLabel>Send policy</FieldLabel>
              <NativeSelect
                value={field.value as string}
                onChange={field.onChange}
              >
                <NativeSelectOption value="open">open</NativeSelectOption>
                <NativeSelectOption value="allowlist">
                  allowlist
                </NativeSelectOption>
                <NativeSelectOption value="disabled">
                  disabled
                </NativeSelectOption>
              </NativeSelect>
            </Field>
          )}
        />
      </div>

      <FormField
        name="discord.commandAllowedUserIds"
        render={({ field }) => (
          <ListField
            label="Allowed command user IDs"
            value={field.value as string[]}
            rows={3}
            placeholder="comma or newline separated"
            onChange={field.onChange}
          />
        )}
      />

      <FormField
        name="discord.sendAllowedChannelIds"
        render={({ field }) => (
          <ListField
            label="Allowed outbound channel IDs"
            value={field.value as string[]}
            rows={3}
            placeholder="comma or newline separated"
            onChange={field.onChange}
          />
        )}
      />

      <FormField
        name="discord.freeResponseChannels"
        render={({ field }) => (
          <ListField
            label="Free response channel IDs"
            value={field.value as string[]}
            rows={3}
            placeholder="comma or newline separated"
            onChange={field.onChange}
          />
        )}
      />

      <div className="field-grid">
        <FormField
          name="discord.typingMode"
          render={({ field }) => (
            <Field>
              <FieldLabel>Typing mode</FieldLabel>
              <NativeSelect
                value={field.value as string}
                onChange={field.onChange}
              >
                <NativeSelectOption value="instant">instant</NativeSelectOption>
                <NativeSelectOption value="thinking">
                  thinking
                </NativeSelectOption>
                <NativeSelectOption value="streaming">
                  streaming
                </NativeSelectOption>
                <NativeSelectOption value="never">never</NativeSelectOption>
              </NativeSelect>
            </Field>
          )}
        />
        <FormField
          name="discord.ackReaction"
          render={({ field }) => (
            <Field>
              <FieldLabel>Ack reaction</FieldLabel>
              <Input {...field} placeholder="👀" />
            </Field>
          )}
        />
      </div>

      <div className="field-grid">
        <FormField
          name="discord.ackReactionScope"
          render={({ field }) => (
            <Field>
              <FieldLabel>Ack reaction scope</FieldLabel>
              <NativeSelect
                value={field.value as string}
                onChange={field.onChange}
              >
                <NativeSelectOption value="all">all</NativeSelectOption>
                <NativeSelectOption value="group-mentions">
                  group-mentions
                </NativeSelectOption>
                <NativeSelectOption value="direct">direct</NativeSelectOption>
                <NativeSelectOption value="off">off</NativeSelectOption>
              </NativeSelect>
            </Field>
          )}
        />
        <FormField
          name="discord.textChunkLimit"
          render={({ field }) => (
            <Field>
              <FieldLabel>Text chunk limit</FieldLabel>
              <NumberField
                integer
                min={0}
                value={field.value as number}
                onValueChange={field.onChange}
              />
            </Field>
          )}
        />
      </div>

      <div className="field-grid">
        <FormField
          name="discord.debounceMs"
          render={({ field }) => (
            <Field>
              <FieldLabel>Debounce ms</FieldLabel>
              <NumberField
                integer
                min={0}
                value={field.value as number}
                onValueChange={field.onChange}
              />
            </Field>
          )}
        />
        <FormField
          name="discord.maxLinesPerMessage"
          render={({ field }) => (
            <Field>
              <FieldLabel>Max lines per message</FieldLabel>
              <NumberField
                integer
                min={0}
                value={field.value as number}
                onValueChange={field.onChange}
              />
            </Field>
          )}
        />
      </div>

      <div className="field-grid">
        <FormField
          name="discord.rateLimitPerUser"
          render={({ field }) => (
            <Field>
              <FieldLabel>Rate limit per user</FieldLabel>
              <NumberField
                integer
                min={0}
                value={field.value as number}
                onValueChange={field.onChange}
              />
            </Field>
          )}
        />
        <FormField
          name="discord.maxConcurrentPerChannel"
          render={({ field }) => (
            <Field>
              <FieldLabel>Max concurrent per channel</FieldLabel>
              <NumberField
                integer
                min={0}
                value={field.value as number}
                onValueChange={field.onChange}
              />
            </Field>
          )}
        />
      </div>

      <FormField
        name="discord.removeAckAfterReply"
        render={({ field }) => (
          <Field orientation="horizontal">
            <Switch
              checked={Boolean(field.value)}
              onCheckedChange={field.onChange}
            />
            <FieldContent>
              <FieldLabel>Remove ack after reply</FieldLabel>
            </FieldContent>
          </Field>
        )}
      />
      <ChannelInstructionsField kind="discord" />
      <p className="muted-copy">
        Discord guild defaults and explicit per-channel overrides stay intact.
        This page edits the transport defaults that apply across the space.
      </p>
    </>
  );
}

function WhatsAppChannelEditor(props: {
  draft: AdminConfig;
  form: UseFormControllerReturn<AdminConfig>;
  linked: boolean;
  pairingQrText: string | null;
  pairingError: string | null;
}) {
  return (
    <>
      <Field orientation="horizontal">
        <Switch
          checked={isWhatsAppEnabled(props.draft)}
          onCheckedChange={(enabled) => {
            const whatsapp = props.draft.whatsapp;
            const dmPolicy =
              enabled && whatsapp.dmPolicy === 'disabled'
                ? 'pairing'
                : enabled
                  ? whatsapp.dmPolicy
                  : 'disabled';
            const groupPolicy = enabled ? whatsapp.groupPolicy : 'disabled';
            props.form.setField('whatsapp.dmPolicy', dmPolicy);
            props.form.setField('whatsapp.groupPolicy', groupPolicy);
          }}
        />
        <FieldContent>
          <FieldLabel>Enabled</FieldLabel>
        </FieldContent>
      </Field>

      <div className="field-grid">
        <FormField
          name="whatsapp.dmPolicy"
          render={({ field }) => (
            <Field>
              <FieldLabel>DM policy</FieldLabel>
              <NativeSelect
                value={field.value as string}
                onChange={field.onChange}
              >
                <NativeSelectOption value="open">open</NativeSelectOption>
                <NativeSelectOption value="pairing">pairing</NativeSelectOption>
                <NativeSelectOption value="allowlist">
                  allowlist
                </NativeSelectOption>
                <NativeSelectOption value="disabled">
                  disabled
                </NativeSelectOption>
              </NativeSelect>
            </Field>
          )}
        />
        <FormField
          name="whatsapp.groupPolicy"
          render={({ field }) => (
            <Field>
              <FieldLabel>Group policy</FieldLabel>
              <NativeSelect
                value={field.value as string}
                onChange={field.onChange}
              >
                <NativeSelectOption value="open">open</NativeSelectOption>
                <NativeSelectOption value="allowlist">
                  allowlist
                </NativeSelectOption>
                <NativeSelectOption value="disabled">
                  disabled
                </NativeSelectOption>
              </NativeSelect>
            </Field>
          )}
        />
      </div>

      {isWhatsAppEnabled(props.draft) && !props.linked ? (
        <div className="field whatsapp-pairing-field">
          <span>Pairing QR</span>
          {props.pairingQrText ? (
            <pre
              className="whatsapp-pairing-qr"
              role="img"
              aria-label="WhatsApp pairing QR"
            >
              {props.pairingQrText}
            </pre>
          ) : (
            <p className="muted-copy">
              {props.pairingError || 'Waiting for a fresh QR from the gateway.'}
            </p>
          )}
        </div>
      ) : null}

      <FormField
        name="whatsapp.allowFrom"
        render={({ field }) => (
          <ListField
            label="Allowed DM senders"
            value={field.value as string[]}
            rows={3}
            placeholder="comma or newline separated"
            onChange={field.onChange}
          />
        )}
      />

      <FormField
        name="whatsapp.groupAllowFrom"
        render={({ field }) => (
          <ListField
            label="Allowed group senders"
            value={field.value as string[]}
            rows={3}
            placeholder="comma or newline separated"
            onChange={field.onChange}
          />
        )}
      />

      <div className="field-grid">
        <FormField
          name="whatsapp.debounceMs"
          render={({ field }) => (
            <Field>
              <FieldLabel>Debounce ms</FieldLabel>
              <NumberField
                integer
                min={0}
                value={field.value as number}
                onValueChange={field.onChange}
              />
            </Field>
          )}
        />
        <FormField
          name="whatsapp.ackReaction"
          render={({ field }) => (
            <Field>
              <FieldLabel>Ack reaction</FieldLabel>
              <Input {...field} />
            </Field>
          )}
        />
      </div>

      <div className="field-grid">
        <FormField
          name="whatsapp.textChunkLimit"
          render={({ field }) => (
            <Field>
              <FieldLabel>Text chunk limit</FieldLabel>
              <NumberField
                integer
                min={0}
                value={field.value as number}
                onValueChange={field.onChange}
              />
            </Field>
          )}
        />
        <FormField
          name="whatsapp.mediaMaxMb"
          render={({ field }) => (
            <Field>
              <FieldLabel>Media max MB</FieldLabel>
              <NumberField
                integer
                min={0}
                value={field.value as number}
                onValueChange={field.onChange}
              />
            </Field>
          )}
        />
      </div>

      <FormField
        name="whatsapp.sendReadReceipts"
        render={({ field }) => (
          <Field orientation="horizontal">
            <Switch
              checked={Boolean(field.value)}
              onCheckedChange={field.onChange}
            />
            <FieldContent>
              <FieldLabel>Send read receipts</FieldLabel>
            </FieldContent>
          </Field>
        )}
      />
      <ChannelInstructionsField kind="whatsapp" />
    </>
  );
}

function TelegramChannelEditor(props: {
  draft: AdminConfig;
  form: UseFormControllerReturn<AdminConfig>;
  tokenConfigured: boolean;
  tokenSource: SecretSource;
  token: string;
  onSecretSaved: () => void;
}) {
  return (
    <>
      <FormField
        name="telegram.enabled"
        render={({ field }) => (
          <Field orientation="horizontal">
            <Switch
              checked={Boolean(field.value)}
              onCheckedChange={field.onChange}
            />
            <FieldContent>
              <FieldLabel>Enabled</FieldLabel>
            </FieldContent>
          </Field>
        )}
      />

      <div className="field-grid">
        <ManagedSecretField
          label="Bot token"
          secretName="TELEGRAM_BOT_TOKEN"
          secretLabel="token"
          configValue={props.draft.telegram.botToken}
          configured={props.tokenConfigured}
          source={props.tokenSource}
          token={props.token}
          onSecretSaved={props.onSecretSaved}
        />
        <FormField
          name="telegram.pollIntervalMs"
          render={({ field }) => (
            <Field>
              <FieldLabel>Poll interval ms</FieldLabel>
              <NumberField
                integer
                min={0}
                value={field.value as number}
                onValueChange={field.onChange}
              />
            </Field>
          )}
        />
      </div>

      <div className="field-grid">
        <FormField
          name="telegram.dmPolicy"
          render={({ field }) => (
            <Field>
              <FieldLabel>DM policy</FieldLabel>
              <NativeSelect
                value={field.value as string}
                onChange={field.onChange}
              >
                <NativeSelectOption value="open">open</NativeSelectOption>
                <NativeSelectOption value="allowlist">
                  allowlist
                </NativeSelectOption>
                <NativeSelectOption value="disabled">
                  disabled
                </NativeSelectOption>
              </NativeSelect>
            </Field>
          )}
        />
        <FormField
          name="telegram.groupPolicy"
          render={({ field }) => (
            <Field>
              <FieldLabel>Group policy</FieldLabel>
              <NativeSelect
                value={field.value as string}
                onChange={field.onChange}
              >
                <NativeSelectOption value="open">open</NativeSelectOption>
                <NativeSelectOption value="allowlist">
                  allowlist
                </NativeSelectOption>
                <NativeSelectOption value="disabled">
                  disabled
                </NativeSelectOption>
              </NativeSelect>
            </Field>
          )}
        />
      </div>

      <FormField
        name="telegram.requireMention"
        render={({ field }) => (
          <Field orientation="horizontal">
            <Switch
              checked={Boolean(field.value)}
              onCheckedChange={field.onChange}
            />
            <FieldContent>
              <FieldLabel>Require mention in groups</FieldLabel>
            </FieldContent>
          </Field>
        )}
      />

      <FormField
        name="telegram.allowFrom"
        render={({ field }) => (
          <ListField
            label="Allowed DM senders"
            value={field.value as string[]}
            rows={3}
            placeholder="numeric user id, @username, or *"
            onChange={field.onChange}
          />
        )}
      />

      <FormField
        name="telegram.groupAllowFrom"
        render={({ field }) => (
          <ListField
            label="Allowed group senders"
            value={field.value as string[]}
            rows={3}
            placeholder="numeric user id, @username, or *"
            onChange={field.onChange}
          />
        )}
      />

      <div className="field-grid">
        <FormField
          name="telegram.textChunkLimit"
          render={({ field }) => (
            <Field>
              <FieldLabel>Text chunk limit</FieldLabel>
              <NumberField
                integer
                min={0}
                value={field.value as number}
                onValueChange={field.onChange}
              />
            </Field>
          )}
        />
        <FormField
          name="telegram.mediaMaxMb"
          render={({ field }) => (
            <Field>
              <FieldLabel>Media max MB</FieldLabel>
              <NumberField
                integer
                min={0}
                value={field.value as number}
                onValueChange={field.onChange}
              />
            </Field>
          )}
        />
      </div>

      <p className="muted-copy">
        Telegram inbound handling stays off until DM or group policy is opened
        or allowlisted.
      </p>
      {!isTelegramInboundEnabled(props.draft) ? (
        <p className="muted-copy">
          This page edits transport-level Telegram settings. Discord and Teams
          remain the only transports with per-channel override bindings.
        </p>
      ) : null}
      <ChannelInstructionsField kind="telegram" />
    </>
  );
}

function ThreemaChannelEditor(props: {
  draft: AdminConfig;
  form: UseFormControllerReturn<AdminConfig>;
  secretConfigured: boolean;
  secretSource: SecretSource;
  token: string;
  onSecretSaved: () => void;
}) {
  return (
    <>
      <FormField
        name="threema.enabled"
        render={({ field }) => (
          <Field orientation="horizontal">
            <Switch
              checked={Boolean(field.value)}
              onCheckedChange={field.onChange}
            />
            <FieldContent>
              <FieldLabel>Enabled</FieldLabel>
            </FieldContent>
          </Field>
        )}
      />

      <div className="field-grid">
        <FormField
          name="threema.identity"
          render={({ field }) => (
            <Field>
              <FieldLabel>Gateway identity</FieldLabel>
              <Input {...field} placeholder="*HYBRID1" />
            </Field>
          )}
        />
        <ManagedSecretField
          label="Gateway secret"
          secretName="THREEMA_GATEWAY_SECRET"
          secretLabel="secret"
          configValue={props.draft.threema.secret}
          configured={props.secretConfigured}
          source={props.secretSource}
          token={props.token}
          onSecretSaved={props.onSecretSaved}
        />
      </div>

      <div className="field-grid">
        <FormField
          name="threema.apiBaseUrl"
          render={({ field }) => (
            <Field>
              <FieldLabel>API base URL</FieldLabel>
              <Input {...field} />
            </Field>
          )}
        />
        <FormField
          name="threema.dmPolicy"
          render={({ field }) => (
            <Field>
              <FieldLabel>DM policy</FieldLabel>
              <NativeSelect
                value={field.value as string}
                onChange={field.onChange}
              >
                <NativeSelectOption value="open">open</NativeSelectOption>
                <NativeSelectOption value="allowlist">
                  allowlist
                </NativeSelectOption>
                <NativeSelectOption value="disabled">
                  disabled
                </NativeSelectOption>
              </NativeSelect>
            </Field>
          )}
        />
      </div>

      <FormField
        name="threema.allowFrom"
        render={({ field }) => (
          <ListField
            label="Allowed senders"
            value={field.value as string[]}
            rows={3}
            placeholder="threema:ABCDEFGH, threema:phone:41791234567, or *"
            onChange={field.onChange}
          />
        )}
      />

      <div className="field-grid">
        <FormField
          name="threema.textChunkLimit"
          render={({ field }) => (
            <Field>
              <FieldLabel>Text chunk limit</FieldLabel>
              <NumberField
                integer
                min={0}
                value={field.value as number}
                onValueChange={field.onChange}
              />
            </Field>
          )}
        />
        <FormField
          name="threema.outboundDelayMs"
          render={({ field }) => (
            <Field>
              <FieldLabel>Outbound delay ms</FieldLabel>
              <NumberField
                integer
                min={0}
                value={field.value as number}
                onValueChange={field.onChange}
              />
            </Field>
          )}
        />
      </div>

      <p className="muted-copy">
        Threema Gateway Basic mode supports outbound text only. Inbound chat
        history, typing, and attachments are not available.
      </p>
      <ChannelInstructionsField kind="threema" />
    </>
  );
}

function SignalChannelEditor(props: {
  draft: AdminConfig;
  form: UseFormControllerReturn<AdminConfig>;
  token: string;
  cliAvailable: boolean;
  cliVersion: string | null;
  cliError: string | null;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [signalCliPath, setSignalCliPath] = useState('signal-cli');
  const [deviceName, setDeviceName] = useState('HybridClaw');
  const signalLinkQuery = useQuery({
    queryKey: ['signal-link', props.token],
    queryFn: () => fetchSignalLink(props.token),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'starting' || status === 'qr' ? 2_000 : false;
    },
  });
  const signalLink = signalLinkQuery.data;
  const signalLinkMutation = useMutation({
    mutationFn: () =>
      startSignalLink(props.token, {
        cliPath: signalCliPath,
        deviceName,
      }),
    onSuccess: (result) => {
      queryClient.setQueryData(['signal-link', props.token], result);
      toast.success('Signal linked-device QR started.');
      void queryClient.invalidateQueries({
        queryKey: ['status', props.token],
      });
    },
    onError: (error) => {
      toast.error('Signal link failed', getErrorMessage(error));
    },
  });

  return (
    <>
      <FormField
        name="signal.enabled"
        render={({ field }) => (
          <Field orientation="horizontal">
            <Switch
              checked={Boolean(field.value)}
              onCheckedChange={field.onChange}
            />
            <FieldContent>
              <FieldLabel>Enabled</FieldLabel>
            </FieldContent>
          </Field>
        )}
      />

      <div className="field-grid">
        <Field>
          <FieldLabel>signal-cli path</FieldLabel>
          <Input
            value={signalCliPath}
            onChange={(event) => setSignalCliPath(event.target.value)}
            placeholder="signal-cli"
          />
        </Field>
        <Field>
          <FieldLabel>Device name</FieldLabel>
          <Input
            value={deviceName}
            onChange={(event) => setDeviceName(event.target.value)}
            placeholder="HybridClaw"
          />
        </Field>
      </div>

      <div className="field whatsapp-pairing-field">
        <span>Linked-device QR</span>
        <div className="button-row">
          <Button
            type="button"
            variant="ghost"
            loading={signalLinkMutation.isPending}
            disabled={
              !props.cliAvailable ||
              signalLinkMutation.isPending ||
              signalLink?.status === 'starting' ||
              signalLink?.status === 'qr'
            }
            onClick={() => signalLinkMutation.mutate()}
          >
            {signalLinkMutation.isPending ? 'Starting...' : 'Start QR link'}
          </Button>
        </div>
        {!props.cliAvailable ? (
          <p className="muted-copy">
            signal-cli is not available on this gateway host. Install
            signal-cli, use a bundled cloud amd64 gateway image, or configure an
            external daemon/sidecar.
            {props.cliError ? ` ${props.cliError}` : ''}
          </p>
        ) : signalLink?.pairingQrText ? (
          <pre
            className="whatsapp-pairing-qr"
            role="img"
            aria-label="Signal linked-device QR"
          >
            {signalLink.pairingQrText}
          </pre>
        ) : signalLink?.status === 'starting' ? (
          <p className="muted-copy">Waiting for signal-cli to print a QR.</p>
        ) : signalLink?.status === 'complete' ? (
          <p className="muted-copy">
            Linked-device flow completed. Start the daemon and save the account
            below.
          </p>
        ) : signalLink?.status === 'error' ? (
          <p className="muted-copy">
            {signalLink.error || 'Signal linked-device setup failed.'}
          </p>
        ) : (
          <p className="muted-copy">
            Starts `signal-cli link -n HybridClaw` on the gateway host
            {props.cliVersion ? ` (${props.cliVersion})` : ''}.
          </p>
        )}
      </div>

      <div className="field-grid">
        <FormField
          name="signal.daemonUrl"
          render={({ field }) => (
            <Field>
              <FieldLabel>Daemon URL</FieldLabel>
              <Input {...field} placeholder="http://127.0.0.1:8080" />
            </Field>
          )}
        />
        <FormField
          name="signal.account"
          render={({ field }) => (
            <Field>
              <FieldLabel>Account</FieldLabel>
              <Input {...field} placeholder="+14155550123" />
            </Field>
          )}
        />
      </div>

      <div className="field-grid">
        <FormField
          name="signal.dmPolicy"
          render={({ field }) => (
            <Field>
              <FieldLabel>DM policy</FieldLabel>
              <NativeSelect
                value={field.value as string}
                onChange={field.onChange}
              >
                <NativeSelectOption value="open">open</NativeSelectOption>
                <NativeSelectOption value="allowlist">
                  allowlist
                </NativeSelectOption>
                <NativeSelectOption value="disabled">
                  disabled
                </NativeSelectOption>
              </NativeSelect>
            </Field>
          )}
        />
        <FormField
          name="signal.groupPolicy"
          render={({ field }) => (
            <Field>
              <FieldLabel>Group policy</FieldLabel>
              <NativeSelect
                value={field.value as string}
                onChange={field.onChange}
              >
                <NativeSelectOption value="open">open</NativeSelectOption>
                <NativeSelectOption value="allowlist">
                  allowlist
                </NativeSelectOption>
                <NativeSelectOption value="disabled">
                  disabled
                </NativeSelectOption>
              </NativeSelect>
            </Field>
          )}
        />
      </div>

      <FormField
        name="signal.allowFrom"
        render={({ field }) => (
          <ListField
            label="Allowed DM senders"
            value={field.value as string[]}
            rows={3}
            placeholder="+14155551212, Signal UUID, or *"
            onChange={field.onChange}
          />
        )}
      />

      <FormField
        name="signal.groupAllowFrom"
        render={({ field }) => (
          <ListField
            label="Allowed group senders"
            value={field.value as string[]}
            rows={3}
            placeholder="+14155551212, Signal UUID, or *"
            onChange={field.onChange}
          />
        )}
      />

      <div className="field-grid">
        <FormField
          name="signal.textChunkLimit"
          render={({ field }) => (
            <Field>
              <FieldLabel>Text chunk limit</FieldLabel>
              <NumberField
                integer
                min={0}
                value={field.value as number}
                onValueChange={field.onChange}
              />
            </Field>
          )}
        />
        <FormField
          name="signal.reconnectIntervalMs"
          render={({ field }) => (
            <Field>
              <FieldLabel>Reconnect interval ms</FieldLabel>
              <NumberField
                integer
                min={0}
                value={field.value as number}
                onValueChange={field.onChange}
              />
            </Field>
          )}
        />
        <FormField
          name="signal.outboundDelayMs"
          render={({ field }) => (
            <Field>
              <FieldLabel>Outbound delay ms</FieldLabel>
              <NumberField
                integer
                min={0}
                value={field.value as number}
                onValueChange={field.onChange}
              />
            </Field>
          )}
        />
      </div>

      <p className="muted-copy">
        After scanning the QR in Signal mobile, start the daemon and save the
        daemon URL here. Groups stay disabled by default; start with one
        allowlisted DM sender.
      </p>
      <ChannelInstructionsField kind="signal" />
    </>
  );
}

function EmailChannelEditor(props: {
  draft: AdminConfig;
  form: UseFormControllerReturn<AdminConfig>;
  passwordConfigured: boolean;
  passwordSource: SecretSource;
  hybridaiApiKeyConfigured: boolean;
  agents: AdminAgent[];
  token: string;
  onSecretSaved: () => void;
}) {
  const [fetchingEmailConfig, setFetchingEmailConfig] = useState(false);
  const toast = useToast();
  const emailAccounts = getEmailAccounts(props.draft);
  const [emailAccountKeys, setEmailAccountKeys] = useState<string[]>(() =>
    emailAccounts.map(() => createEmailAccountKey()),
  );

  useEffect(() => {
    setEmailAccountKeys((current) => {
      if (current.length === emailAccounts.length) return current;
      if (current.length > emailAccounts.length) {
        return current.slice(0, emailAccounts.length);
      }
      return [
        ...current,
        ...Array.from(
          { length: emailAccounts.length - current.length },
          createEmailAccountKey,
        ),
      ];
    });
  }, [emailAccounts.length]);

  function setEmailAccounts(next: EmailAccountConfig[]) {
    props.form.setField('email.accounts', next);
  }

  function updateEmailAccount(
    index: number,
    update: (account: EmailAccountConfig) => EmailAccountConfig,
  ) {
    setEmailAccounts(
      emailAccounts.map((account, currentIndex) =>
        currentIndex === index ? update(account) : account,
      ),
    );
  }

  function addEmailAccount() {
    setEmailAccountKeys((current) => [...current, createEmailAccountKey()]);
    setEmailAccounts([...emailAccounts, createEmailAccount(props.draft.email)]);
  }

  function removeEmailAccount(index: number) {
    setEmailAccountKeys((current) =>
      current.filter((_, currentIndex) => currentIndex !== index),
    );
    setEmailAccounts(
      emailAccounts.filter((_, currentIndex) => currentIndex !== index),
    );
  }

  async function handleFetchEmailConfig() {
    setFetchingEmailConfig(true);
    try {
      const result = (await fetchEmailConfig(props.token)) as {
        handles?: Array<{
          id?: string;
          handle?: string;
          status?: string;
        }>;
        credentials?: {
          email?: string;
          password?: string;
          imap_host?: string;
          imap_port?: number;
          smtp_host?: string;
          smtp_port?: number;
        } | null;
        handleId?: string;
      };

      const handles = result?.handles;
      if (!Array.isArray(handles) || handles.length === 0) {
        toast.info('No HybridAI agent handles found.');
        return;
      }

      const creds = result?.credentials;
      if (!creds) {
        const summary = handles
          .map((h) => `${h.handle} (${h.status})`)
          .join(', ');
        toast.info(
          `Handles found: ${summary}. Could not retrieve mailbox credentials.`,
        );
        return;
      }

      if (creds.email) props.form.setField('email.address', creds.email);
      if (creds.imap_host)
        props.form.setField('email.imapHost', creds.imap_host);
      if (creds.imap_port != null)
        props.form.setField('email.imapPort', creds.imap_port);
      if (creds.smtp_host)
        props.form.setField('email.smtpHost', creds.smtp_host);
      if (creds.smtp_port != null)
        props.form.setField('email.smtpPort', creds.smtp_port);

      // Save password as runtime secret before showing success
      if (creds.password) {
        try {
          await setRuntimeSecret(props.token, 'EMAIL_PASSWORD', creds.password);
          props.onSecretSaved();
        } catch (err) {
          toast.error('Password could not be saved', getErrorMessage(err));
          toast.info(
            'Email fields were populated, but password was not saved.',
          );
          return;
        }
      }

      const label = result.handleId || 'HybridAI';
      toast.success(`Email config loaded from ${label}.`);
    } catch (error) {
      toast.error('Failed to fetch email config', getErrorMessage(error));
    } finally {
      setFetchingEmailConfig(false);
    }
  }

  return (
    <>
      <FormField
        name="email.enabled"
        render={({ field }) => (
          <Field orientation="horizontal">
            <Switch
              checked={Boolean(field.value)}
              onCheckedChange={field.onChange}
            />
            <FieldContent>
              <FieldLabel>Enabled</FieldLabel>
            </FieldContent>
          </Field>
        )}
      />

      {props.hybridaiApiKeyConfigured ? (
        <div className="button-row">
          <Button
            type="button"
            variant="ghost"
            loading={fetchingEmailConfig}
            disabled={fetchingEmailConfig}
            onClick={handleFetchEmailConfig}
          >
            {fetchingEmailConfig ? 'Fetching…' : 'Fetch HybridAI Agent Email'}
          </Button>
        </div>
      ) : null}

      <div className="email-account-section-header">
        <h4>
          Default agent mailbox:
          <span className="email-default-agent-target">
            {formatDefaultEmailAgentLabel(props.agents)}
          </span>
        </h4>
      </div>

      <div className="field-grid">
        <FormField
          name="email.address"
          render={({ field }) => (
            <Field>
              <FieldLabel>Default mailbox address</FieldLabel>
              <Input {...field} placeholder="bot@example.com" />
            </Field>
          )}
        />
        <ManagedSecretField
          label="Default mailbox password"
          secretName="EMAIL_PASSWORD"
          secretLabel="password"
          configValue={props.draft.email.password}
          configured={props.passwordConfigured}
          source={props.passwordSource}
          token={props.token}
          onSecretSaved={props.onSecretSaved}
        />
      </div>

      <div className="field-grid">
        <FormField
          name="email.imapHost"
          render={({ field }) => (
            <Field>
              <FieldLabel>IMAP host</FieldLabel>
              <Input {...field} />
            </Field>
          )}
        />
        <FormField
          name="email.smtpHost"
          render={({ field }) => (
            <Field>
              <FieldLabel>SMTP host</FieldLabel>
              <Input {...field} />
            </Field>
          )}
        />
      </div>

      <div className="field-grid">
        <FormField
          name="email.imapPort"
          render={({ field }) => (
            <Field>
              <FieldLabel>IMAP port</FieldLabel>
              <NumberField
                integer
                min={0}
                value={field.value as number}
                onValueChange={field.onChange}
              />
            </Field>
          )}
        />
        <FormField
          name="email.smtpPort"
          render={({ field }) => (
            <Field>
              <FieldLabel>SMTP port</FieldLabel>
              <NumberField
                integer
                min={0}
                value={field.value as number}
                onValueChange={field.onChange}
              />
            </Field>
          )}
        />
      </div>

      <div className="field-grid">
        <FormField
          name="email.imapSecure"
          render={({ field }) => (
            <Field orientation="horizontal">
              <Switch
                checked={Boolean(field.value)}
                onCheckedChange={field.onChange}
              />
              <FieldContent>
                <FieldLabel>IMAP secure</FieldLabel>
              </FieldContent>
            </Field>
          )}
        />
        <FormField
          name="email.smtpSecure"
          render={({ field }) => (
            <Field orientation="horizontal">
              <Switch
                checked={Boolean(field.value)}
                onCheckedChange={field.onChange}
              />
              <FieldContent>
                <FieldLabel>SMTP secure</FieldLabel>
              </FieldContent>
            </Field>
          )}
        />
      </div>

      <FormField
        name="email.folders"
        render={({ field }) => (
          <ListField
            label="Folders"
            value={field.value as string[]}
            rows={3}
            placeholder="INBOX, Support"
            onChange={field.onChange}
          />
        )}
      />

      <FormField
        name="email.allowFrom"
        render={({ field }) => (
          <ListField
            label="Allowed senders"
            value={field.value as string[]}
            rows={3}
            placeholder="name@example.com, *@example.com"
            onChange={field.onChange}
          />
        )}
      />

      <div className="field-grid">
        <FormField
          name="email.pollIntervalMs"
          render={({ field }) => (
            <Field>
              <FieldLabel>Poll interval ms</FieldLabel>
              <NumberField
                integer
                min={0}
                value={field.value as number}
                onValueChange={field.onChange}
              />
            </Field>
          )}
        />
        <FormField
          name="email.textChunkLimit"
          render={({ field }) => (
            <Field>
              <FieldLabel>Text chunk limit</FieldLabel>
              <NumberField
                integer
                min={0}
                value={field.value as number}
                onValueChange={field.onChange}
              />
            </Field>
          )}
        />
      </div>

      <FormField
        name="email.mediaMaxMb"
        render={({ field }) => (
          <Field>
            <FieldLabel>Media max MB</FieldLabel>
            <NumberField
              integer
              min={0}
              value={field.value as number}
              onValueChange={field.onChange}
            />
          </Field>
        )}
      />
      <div className="email-account-section">
        <div className="email-account-section-header">
          <h4>Additional agent mailboxes</h4>
          <Button type="button" variant="ghost" onClick={addEmailAccount}>
            Add additional mailbox
          </Button>
        </div>

        {emailAccounts.length === 0 ? (
          <div className="empty-state email-account-empty">
            No additional agent mailboxes configured.
          </div>
        ) : (
          <div className="email-account-list">
            {emailAccounts.map((account, index) => {
              const accountKey =
                emailAccountKeys[index] ||
                `${account.agentId}:${account.address}:${account.imapHost}:${account.smtpHost}`;
              const selectedAgentKnown = props.agents.some(
                (agent) => agent.id === account.agentId,
              );
              return (
                <div className="email-account-row" key={accountKey}>
                  <div className="email-account-row-header">
                    <strong>{account.address || `Mailbox ${index + 1}`}</strong>
                    <Button
                      aria-label={`Remove mailbox ${index + 1}`}
                      title={`Remove mailbox ${index + 1}`}
                      className="email-account-remove"
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removeEmailAccount(index)}
                    >
                      <Trash width="16" height="16" />
                    </Button>
                  </div>

                  <div className="field-grid">
                    <Field>
                      <FieldLabel>Agent</FieldLabel>
                      {props.agents.length > 0 ? (
                        <NativeSelect
                          value={account.agentId}
                          onChange={(event) =>
                            updateEmailAccount(index, (current) => ({
                              ...current,
                              agentId: event.target.value,
                            }))
                          }
                        >
                          <NativeSelectOption value="">
                            Select agent
                          </NativeSelectOption>
                          {props.agents.map((agent) => (
                            <NativeSelectOption key={agent.id} value={agent.id}>
                              {formatAgentOptionLabel(agent)}
                            </NativeSelectOption>
                          ))}
                          {account.agentId && !selectedAgentKnown ? (
                            <NativeSelectOption value={account.agentId}>
                              {account.agentId}
                            </NativeSelectOption>
                          ) : null}
                        </NativeSelect>
                      ) : (
                        <Input
                          value={account.agentId}
                          placeholder="sales"
                          onChange={(event) =>
                            updateEmailAccount(index, (current) => ({
                              ...current,
                              agentId: event.target.value,
                            }))
                          }
                        />
                      )}
                    </Field>
                    <Field>
                      <FieldLabel>Mailbox address</FieldLabel>
                      <Input
                        type="email"
                        value={account.address}
                        placeholder="sales@example.com"
                        onChange={(event) =>
                          updateEmailAccount(index, (current) => ({
                            ...current,
                            address: event.target.value,
                          }))
                        }
                      />
                    </Field>
                  </div>

                  <Field>
                    <FieldLabel>Password SecretRef id</FieldLabel>
                    <Input
                      value={getEmailAccountPasswordRefId(account)}
                      placeholder="SALES_EMAIL_PASSWORD"
                      onChange={(event) =>
                        updateEmailAccount(index, (current) =>
                          setEmailAccountPasswordRefId(
                            current,
                            event.target.value.trim(),
                          ),
                        )
                      }
                    />
                  </Field>

                  <div className="field-grid">
                    <Field>
                      <FieldLabel>Mailbox IMAP host</FieldLabel>
                      <Input
                        value={account.imapHost}
                        onChange={(event) =>
                          updateEmailAccount(index, (current) => ({
                            ...current,
                            imapHost: event.target.value,
                          }))
                        }
                      />
                    </Field>
                    <Field>
                      <FieldLabel>Mailbox SMTP host</FieldLabel>
                      <Input
                        value={account.smtpHost}
                        onChange={(event) =>
                          updateEmailAccount(index, (current) => ({
                            ...current,
                            smtpHost: event.target.value,
                          }))
                        }
                      />
                    </Field>
                  </div>

                  <div className="field-grid">
                    <Field>
                      <FieldLabel>Mailbox IMAP port</FieldLabel>
                      <NumberField
                        integer
                        min={0}
                        value={account.imapPort}
                        onValueChange={(imapPort) =>
                          updateEmailAccount(index, (current) => ({
                            ...current,
                            imapPort,
                          }))
                        }
                      />
                    </Field>
                    <Field>
                      <FieldLabel>Mailbox SMTP port</FieldLabel>
                      <NumberField
                        integer
                        min={0}
                        value={account.smtpPort}
                        onValueChange={(smtpPort) =>
                          updateEmailAccount(index, (current) => ({
                            ...current,
                            smtpPort,
                          }))
                        }
                      />
                    </Field>
                  </div>

                  <div className="field-grid">
                    <Field orientation="horizontal">
                      <Switch
                        checked={account.imapSecure}
                        onCheckedChange={(imapSecure) =>
                          updateEmailAccount(index, (current) => ({
                            ...current,
                            imapSecure,
                          }))
                        }
                      />
                      <FieldContent>
                        <FieldLabel>Mailbox IMAP secure</FieldLabel>
                      </FieldContent>
                    </Field>
                    <Field orientation="horizontal">
                      <Switch
                        checked={account.smtpSecure}
                        onCheckedChange={(smtpSecure) =>
                          updateEmailAccount(index, (current) => ({
                            ...current,
                            smtpSecure,
                          }))
                        }
                      />
                      <FieldContent>
                        <FieldLabel>Mailbox SMTP secure</FieldLabel>
                      </FieldContent>
                    </Field>
                  </div>

                  <ListField
                    label="Mailbox folders"
                    value={account.folders}
                    rows={2}
                    placeholder="INBOX, Support"
                    onChange={(folders) =>
                      updateEmailAccount(index, (current) => ({
                        ...current,
                        folders,
                      }))
                    }
                  />

                  <ListField
                    label="Mailbox allowed senders"
                    value={account.allowFrom}
                    rows={2}
                    placeholder="name@example.com, *@example.com"
                    onChange={(allowFrom) =>
                      updateEmailAccount(index, (current) => ({
                        ...current,
                        allowFrom,
                      }))
                    }
                  />

                  <div className="field-grid">
                    <Field>
                      <FieldLabel>Mailbox poll interval ms</FieldLabel>
                      <NumberField
                        integer
                        min={0}
                        value={account.pollIntervalMs}
                        onValueChange={(pollIntervalMs) =>
                          updateEmailAccount(index, (current) => ({
                            ...current,
                            pollIntervalMs,
                          }))
                        }
                      />
                    </Field>
                    <Field>
                      <FieldLabel>Mailbox media max MB</FieldLabel>
                      <NumberField
                        integer
                        min={0}
                        value={account.mediaMaxMb}
                        onValueChange={(mediaMaxMb) =>
                          updateEmailAccount(index, (current) => ({
                            ...current,
                            mediaMaxMb,
                          }))
                        }
                      />
                    </Field>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <ChannelInstructionsField kind="email" />
    </>
  );
}

function VoiceChannelEditor(props: {
  draft: AdminConfig;
  form: UseFormControllerReturn<AdminConfig>;
  authTokenConfigured: boolean;
  authTokenSource: SecretSource;
  token: string;
  onSecretSaved: () => void;
}) {
  return (
    <>
      <FormField
        name="voice.enabled"
        render={({ field }) => (
          <Field orientation="horizontal">
            <Switch
              checked={Boolean(field.value)}
              onCheckedChange={field.onChange}
            />
            <FieldContent>
              <FieldLabel>Enabled</FieldLabel>
            </FieldContent>
          </Field>
        )}
      />

      <div className="field-grid">
        <FormField
          name="voice.twilio.accountSid"
          render={({ field }) => (
            <Field>
              <FieldLabel>Twilio account SID</FieldLabel>
              <Input {...field} placeholder="AC..." />
            </Field>
          )}
        />
        <FormField
          name="voice.twilio.fromNumber"
          render={({ field }) => (
            <Field>
              <FieldLabel>From number</FieldLabel>
              <Input {...field} placeholder="+14155550123" />
            </Field>
          )}
        />
      </div>

      <ManagedSecretField
        label="Twilio auth token"
        secretName="TWILIO_AUTH_TOKEN"
        secretLabel="token"
        configValue={props.draft.voice.twilio.authToken}
        configured={props.authTokenConfigured}
        source={props.authTokenSource}
        token={props.token}
        onSecretSaved={props.onSecretSaved}
      />

      <div className="field-grid">
        <FormField
          name="voice.webhookPath"
          render={({ field }) => (
            <Field>
              <FieldLabel>Webhook path</FieldLabel>
              <Input {...field} placeholder="/voice" />
            </Field>
          )}
        />
        <FormField
          name="voice.maxConcurrentCalls"
          render={({ field }) => (
            <Field>
              <FieldLabel>Max concurrent calls</FieldLabel>
              <NumberField
                integer
                min={0}
                value={field.value as number}
                onValueChange={field.onChange}
              />
            </Field>
          )}
        />
      </div>

      <div className="field-grid">
        <FormField
          name="voice.relay.ttsProvider"
          render={({ field }) => (
            <Field>
              <FieldLabel>TTS provider</FieldLabel>
              <NativeSelect
                value={field.value as string}
                onChange={field.onChange}
              >
                <NativeSelectOption value="default">default</NativeSelectOption>
                <NativeSelectOption value="google">google</NativeSelectOption>
                <NativeSelectOption value="amazon">amazon</NativeSelectOption>
              </NativeSelect>
            </Field>
          )}
        />
        <FormField
          name="voice.relay.voice"
          render={({ field }) => (
            <Field>
              <FieldLabel>Voice</FieldLabel>
              <Input {...field} placeholder="en-US-Journey-D" />
            </Field>
          )}
        />
      </div>

      <div className="field-grid">
        <FormField
          name="voice.relay.transcriptionProvider"
          render={({ field }) => (
            <Field>
              <FieldLabel>Transcription provider</FieldLabel>
              <NativeSelect
                value={field.value as string}
                onChange={field.onChange}
              >
                <NativeSelectOption value="default">default</NativeSelectOption>
                <NativeSelectOption value="deepgram">
                  deepgram
                </NativeSelectOption>
                <NativeSelectOption value="google">google</NativeSelectOption>
              </NativeSelect>
            </Field>
          )}
        />
        <FormField
          name="voice.relay.language"
          render={({ field }) => (
            <Field>
              <FieldLabel>Language</FieldLabel>
              <Input {...field} placeholder="en-US" />
            </Field>
          )}
        />
      </div>

      <FormField
        name="voice.relay.interruptible"
        render={({ field }) => (
          <Field orientation="horizontal">
            <Switch
              checked={Boolean(field.value)}
              onCheckedChange={field.onChange}
            />
            <FieldContent>
              <FieldLabel>Interruptible</FieldLabel>
            </FieldContent>
          </Field>
        )}
      />

      <FormField
        name="voice.relay.welcomeGreeting"
        render={({ field }) => (
          <Field>
            <FieldLabel>Welcome greeting</FieldLabel>
            <Textarea rows={3} {...field} />
          </Field>
        )}
      />
      <ChannelInstructionsField kind="voice" />

      <p className="muted-copy">
        Voice uses Twilio ConversationRelay. Expose the configured webhook path
        over public HTTPS and WSS so Twilio can reach both the webhook and the
        relay socket.
      </p>
    </>
  );
}

function TeamsChannelEditor(props: {
  draft: AdminConfig;
  form: UseFormControllerReturn<AdminConfig>;
}) {
  const teamCount = countTeams(props.draft);
  const overrideCount = countTeamsOverrides(props.draft);

  return (
    <>
      <div className="key-value-grid">
        <div>
          <span>Team defaults</span>
          <strong>{String(teamCount)}</strong>
          <small>Per-team rules preserved</small>
        </div>
        <div>
          <span>Channel overrides</span>
          <strong>{String(overrideCount)}</strong>
          <small>Explicit Teams channel entries</small>
        </div>
      </div>

      <FormField
        name="msteams.enabled"
        render={({ field }) => (
          <Field orientation="horizontal">
            <Switch
              checked={Boolean(field.value)}
              onCheckedChange={field.onChange}
            />
            <FieldContent>
              <FieldLabel>Enabled</FieldLabel>
            </FieldContent>
          </Field>
        )}
      />

      <div className="field-grid">
        <FormField
          name="msteams.appId"
          render={({ field }) => (
            <Field>
              <FieldLabel>App ID</FieldLabel>
              <Input {...field} />
            </Field>
          )}
        />
        <FormField
          name="msteams.tenantId"
          render={({ field }) => (
            <Field>
              <FieldLabel>Tenant ID</FieldLabel>
              <Input {...field} />
            </Field>
          )}
        />
      </div>

      <div className="field-grid">
        <FormField
          name="msteams.webhook.path"
          render={({ field }) => (
            <Field>
              <FieldLabel>Webhook path</FieldLabel>
              <Input {...field} />
            </Field>
          )}
        />
        <FormField
          name="msteams.webhook.port"
          render={({ field }) => (
            <Field>
              <FieldLabel>Webhook port</FieldLabel>
              <NumberField
                integer
                min={0}
                max={65535}
                value={field.value as number}
                onValueChange={field.onChange}
              />
            </Field>
          )}
        />
      </div>

      <div className="field-grid">
        <FormField
          name="msteams.dmPolicy"
          render={({ field }) => (
            <Field>
              <FieldLabel>DM policy</FieldLabel>
              <NativeSelect
                value={field.value as string}
                onChange={field.onChange}
              >
                <NativeSelectOption value="open">open</NativeSelectOption>
                <NativeSelectOption value="allowlist">
                  allowlist
                </NativeSelectOption>
                <NativeSelectOption value="disabled">
                  disabled
                </NativeSelectOption>
              </NativeSelect>
            </Field>
          )}
        />
        <FormField
          name="msteams.groupPolicy"
          render={({ field }) => (
            <Field>
              <FieldLabel>Group policy</FieldLabel>
              <NativeSelect
                value={field.value as string}
                onChange={field.onChange}
              >
                <NativeSelectOption value="open">open</NativeSelectOption>
                <NativeSelectOption value="allowlist">
                  allowlist
                </NativeSelectOption>
                <NativeSelectOption value="disabled">
                  disabled
                </NativeSelectOption>
              </NativeSelect>
            </Field>
          )}
        />
      </div>

      <div className="field-grid">
        <FormField
          name="msteams.requireMention"
          render={({ field }) => (
            <Field orientation="horizontal">
              <Switch
                checked={Boolean(field.value)}
                onCheckedChange={field.onChange}
              />
              <FieldContent>
                <FieldLabel>Require mention</FieldLabel>
              </FieldContent>
            </Field>
          )}
        />
        <FormField
          name="msteams.replyStyle"
          render={({ field }) => (
            <Field>
              <FieldLabel>Reply style</FieldLabel>
              <NativeSelect
                value={field.value as string}
                onChange={field.onChange}
              >
                <NativeSelectOption value="thread">thread</NativeSelectOption>
                <NativeSelectOption value="top-level">
                  top-level
                </NativeSelectOption>
              </NativeSelect>
            </Field>
          )}
        />
      </div>

      <FormField
        name="msteams.allowFrom"
        render={({ field }) => (
          <ListField
            label="Allowed AAD object IDs"
            value={field.value as string[]}
            rows={4}
            placeholder="comma or newline separated"
            onChange={field.onChange}
          />
        )}
      />

      <div className="field-grid">
        <FormField
          name="msteams.textChunkLimit"
          render={({ field }) => (
            <Field>
              <FieldLabel>Text chunk limit</FieldLabel>
              <NumberField
                integer
                min={0}
                value={field.value as number}
                onValueChange={field.onChange}
              />
            </Field>
          )}
        />
        <FormField
          name="msteams.mediaMaxMb"
          render={({ field }) => (
            <Field>
              <FieldLabel>Media max MB</FieldLabel>
              <NumberField
                integer
                min={0}
                value={field.value as number}
                onValueChange={field.onChange}
              />
            </Field>
          )}
        />
      </div>
      <ChannelInstructionsField kind="msteams" />
    </>
  );
}

function SlackChannelEditor(props: {
  draft: AdminConfig;
  form: UseFormControllerReturn<AdminConfig>;
  botTokenConfigured: boolean;
  botTokenSource: SecretSource;
  appTokenConfigured: boolean;
  appTokenSource: SecretSource;
  token: string;
  onSecretSaved: () => void;
}) {
  return (
    <>
      <FormField
        name="slack.enabled"
        render={({ field }) => (
          <Field orientation="horizontal">
            <Switch
              checked={Boolean(field.value)}
              onCheckedChange={field.onChange}
            />
            <FieldContent>
              <FieldLabel>Enabled</FieldLabel>
            </FieldContent>
          </Field>
        )}
      />

      <ManagedSecretField
        label="Bot token"
        secretName="SLACK_BOT_TOKEN"
        secretLabel="token"
        configured={props.botTokenConfigured}
        source={props.botTokenSource}
        token={props.token}
        onSecretSaved={props.onSecretSaved}
      />

      <ManagedSecretField
        label="App token"
        secretName="SLACK_APP_TOKEN"
        secretLabel="token"
        configured={props.appTokenConfigured}
        source={props.appTokenSource}
        token={props.token}
        onSecretSaved={props.onSecretSaved}
      />

      <div className="field-grid">
        <FormField
          name="slack.dmPolicy"
          render={({ field }) => (
            <Field>
              <FieldLabel>DM policy</FieldLabel>
              <NativeSelect
                value={field.value as string}
                onChange={field.onChange}
              >
                <NativeSelectOption value="open">open</NativeSelectOption>
                <NativeSelectOption value="allowlist">
                  allowlist
                </NativeSelectOption>
                <NativeSelectOption value="disabled">
                  disabled
                </NativeSelectOption>
              </NativeSelect>
            </Field>
          )}
        />
        <FormField
          name="slack.groupPolicy"
          render={({ field }) => (
            <Field>
              <FieldLabel>Group policy</FieldLabel>
              <NativeSelect
                value={field.value as string}
                onChange={field.onChange}
              >
                <NativeSelectOption value="open">open</NativeSelectOption>
                <NativeSelectOption value="allowlist">
                  allowlist
                </NativeSelectOption>
                <NativeSelectOption value="disabled">
                  disabled
                </NativeSelectOption>
              </NativeSelect>
            </Field>
          )}
        />
      </div>

      <div className="field-grid">
        <FormField
          name="slack.requireMention"
          render={({ field }) => (
            <Field orientation="horizontal">
              <Switch
                checked={Boolean(field.value)}
                onCheckedChange={field.onChange}
              />
              <FieldContent>
                <FieldLabel>Require mention</FieldLabel>
              </FieldContent>
            </Field>
          )}
        />
        <FormField
          name="slack.replyStyle"
          render={({ field }) => (
            <Field>
              <FieldLabel>Reply style</FieldLabel>
              <NativeSelect
                value={field.value as string}
                onChange={field.onChange}
              >
                <NativeSelectOption value="thread">thread</NativeSelectOption>
                <NativeSelectOption value="top-level">
                  top-level
                </NativeSelectOption>
              </NativeSelect>
            </Field>
          )}
        />
      </div>

      <FormField
        name="slack.allowFrom"
        render={({ field }) => (
          <ListField
            label="Allowed DM Slack user IDs"
            value={field.value as string[]}
            rows={4}
            placeholder="comma or newline separated"
            onChange={field.onChange}
          />
        )}
      />

      <FormField
        name="slack.groupAllowFrom"
        render={({ field }) => (
          <ListField
            label="Allowed channel Slack user IDs"
            value={field.value as string[]}
            rows={4}
            placeholder="comma or newline separated"
            onChange={field.onChange}
          />
        )}
      />

      <div className="field-grid">
        <FormField
          name="slack.textChunkLimit"
          render={({ field }) => (
            <Field>
              <FieldLabel>Text chunk limit</FieldLabel>
              <NumberField
                integer
                min={0}
                value={field.value as number}
                onValueChange={field.onChange}
              />
            </Field>
          )}
        />
        <FormField
          name="slack.mediaMaxMb"
          render={({ field }) => (
            <Field>
              <FieldLabel>Media max MB</FieldLabel>
              <NumberField
                integer
                min={0}
                value={field.value as number}
                onValueChange={field.onChange}
              />
            </Field>
          )}
        />
      </div>

      <p className="muted-copy">
        Slack runs through Socket Mode. HybridClaw needs both a bot token and an
        app token before the gateway can connect.
      </p>
      <ChannelInstructionsField kind="slack" />
    </>
  );
}

function SlackWebhookChannelEditor(props: {
  draft: AdminConfig;
  onConfigSaved: (config: AdminConfig) => void;
  token: string;
  form: UseFormControllerReturn<AdminConfig>;
}) {
  const toast = useToast();
  const targets = Object.keys(props.draft.slackWebhook.webhooks).sort();
  const [target, setTarget] = useState(targets[0] || 'default');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [defaultUsername, setDefaultUsername] = useState('');
  const [defaultIconEmoji, setDefaultIconEmoji] = useState('');
  const [defaultIconUrl, setDefaultIconUrl] = useState('');
  const selectedTarget = props.draft.slackWebhook.webhooks[target];
  const saveTargetMutation = useMutation({
    mutationFn: async () =>
      saveSlackWebhookTarget(props.token, {
        target,
        webhookUrl: webhookUrl.trim() || undefined,
        defaultUsername,
        defaultIconEmoji,
        defaultIconUrl,
      }),
    onSuccess: (payload) => {
      props.onConfigSaved(payload.config);
      setWebhookUrl('');
      toast.success('Slack webhook target saved.');
    },
    onError: (error) => {
      toast.error('Save failed', getErrorMessage(error));
    },
  });

  useEffect(() => {
    const config = props.draft.slackWebhook.webhooks[target];
    setDefaultUsername(config?.defaultUsername || '');
    setDefaultIconEmoji(config?.defaultIconEmoji || '');
    setDefaultIconUrl(config?.defaultIconUrl || '');
  }, [props.draft.slackWebhook.webhooks, target]);

  return (
    <>
      <FormField
        name="slackWebhook.enabled"
        render={({ field }) => (
          <Field orientation="horizontal">
            <Switch
              checked={Boolean(field.value)}
              onCheckedChange={field.onChange}
            />
            <FieldContent>
              <FieldLabel>Enabled</FieldLabel>
            </FieldContent>
          </Field>
        )}
      />

      <div className="field">
        <span>Webhook targets</span>
        <div className="readonly-value">
          {targets.length > 0 ? targets.join(', ') : 'none'}
        </div>
      </div>

      <div className="field-grid">
        <Field>
          <FieldLabel>Target</FieldLabel>
          <Input
            list="slack-webhook-targets"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          />
          <datalist id="slack-webhook-targets">
            {targets.map((entry) => (
              <NativeSelectOption key={entry} value={entry} />
            ))}
          </datalist>
        </Field>
        <Field>
          <FieldLabel>Webhook URL</FieldLabel>
          <Input
            type="password"
            autoComplete="off"
            placeholder={
              selectedTarget ? 'leave blank to keep current URL' : 'required'
            }
            value={webhookUrl}
            onChange={(event) => setWebhookUrl(event.target.value)}
          />
        </Field>
      </div>

      <div className="field-grid">
        <Field>
          <FieldLabel>Username</FieldLabel>
          <Input
            value={defaultUsername}
            onChange={(event) => setDefaultUsername(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel>Icon emoji</FieldLabel>
          <Input
            value={defaultIconEmoji}
            onChange={(event) => setDefaultIconEmoji(event.target.value)}
          />
        </Field>
      </div>

      <Field>
        <FieldLabel>Icon URL</FieldLabel>
        <Input
          value={defaultIconUrl}
          onChange={(event) => setDefaultIconUrl(event.target.value)}
        />
      </Field>

      <div className="button-row">
        <button
          className="secondary-button"
          type="button"
          disabled={saveTargetMutation.isPending}
          onClick={() => saveTargetMutation.mutate()}
        >
          {saveTargetMutation.isPending ? 'Saving...' : 'Save webhook target'}
        </button>
      </div>

      <p className="muted-copy">
        Webhook URLs are stored as encrypted runtime secrets and are never shown
        after save.
      </p>

      <ChannelInstructionsField kind="slack_webhook" />
    </>
  );
}

function DiscordWebhookChannelEditor(props: {
  draft: AdminConfig;
  onConfigSaved: (config: AdminConfig) => void;
  token: string;
  form: UseFormControllerReturn<AdminConfig>;
}) {
  const toast = useToast();
  const targets = Object.keys(props.draft.discordWebhook.webhooks).sort();
  const [target, setTarget] = useState(targets[0] || 'default');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [defaultUsername, setDefaultUsername] = useState('');
  const [defaultAvatarUrl, setDefaultAvatarUrl] = useState('');
  const selectedTarget = props.draft.discordWebhook.webhooks[target];
  const saveTargetMutation = useMutation({
    mutationFn: async () =>
      saveDiscordWebhookTarget(props.token, {
        target,
        webhookUrl: webhookUrl.trim() || undefined,
        defaultUsername,
        defaultAvatarUrl,
      }),
    onSuccess: (payload) => {
      props.onConfigSaved(payload.config);
      setWebhookUrl('');
      toast.success('Discord webhook target saved.');
    },
    onError: (error) => {
      toast.error('Save failed', getErrorMessage(error));
    },
  });

  useEffect(() => {
    const config = props.draft.discordWebhook.webhooks[target];
    setDefaultUsername(config?.defaultUsername || '');
    setDefaultAvatarUrl(config?.defaultAvatarUrl || '');
  }, [props.draft.discordWebhook.webhooks, target]);

  return (
    <>
      <FormField
        name="discordWebhook.enabled"
        render={({ field }) => (
          <Field orientation="horizontal">
            <Switch
              checked={Boolean(field.value)}
              onCheckedChange={field.onChange}
            />
            <FieldContent>
              <FieldLabel>Enabled</FieldLabel>
            </FieldContent>
          </Field>
        )}
      />

      <div className="field">
        <span>Webhook targets</span>
        <div className="readonly-value">
          {targets.length > 0 ? targets.join(', ') : 'none'}
        </div>
      </div>

      <div className="field-grid">
        <Field>
          <FieldLabel>Target</FieldLabel>
          <Input
            list="discord-webhook-targets"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          />
          <datalist id="discord-webhook-targets">
            {targets.map((entry) => (
              <NativeSelectOption key={entry} value={entry} />
            ))}
          </datalist>
        </Field>
        <Field>
          <FieldLabel>Webhook URL</FieldLabel>
          <Input
            type="password"
            autoComplete="off"
            placeholder={
              selectedTarget ? 'leave blank to keep current URL' : 'required'
            }
            value={webhookUrl}
            onChange={(event) => setWebhookUrl(event.target.value)}
          />
        </Field>
      </div>

      <div className="field-grid">
        <Field>
          <FieldLabel>Username</FieldLabel>
          <Input
            value={defaultUsername}
            onChange={(event) => setDefaultUsername(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel>Avatar URL</FieldLabel>
          <Input
            value={defaultAvatarUrl}
            onChange={(event) => setDefaultAvatarUrl(event.target.value)}
          />
        </Field>
      </div>

      <div className="button-row">
        <button
          className="secondary-button"
          type="button"
          disabled={saveTargetMutation.isPending}
          onClick={() => saveTargetMutation.mutate()}
        >
          {saveTargetMutation.isPending ? 'Saving...' : 'Save webhook target'}
        </button>
      </div>

      <p className="muted-copy">
        Webhook URLs are stored as encrypted runtime secrets and are never shown
        after save.
      </p>

      <ChannelInstructionsField kind="discord_webhook" />
    </>
  );
}

function IMessageChannelEditor(props: {
  draft: AdminConfig;
  form: UseFormControllerReturn<AdminConfig>;
  passwordConfigured: boolean;
  passwordSource: SecretSource;
  token: string;
  onSecretSaved: () => void;
}) {
  const isRemote = props.draft.imessage.backend === 'bluebubbles';

  return (
    <>
      <FormField
        name="imessage.enabled"
        render={({ field }) => (
          <Field orientation="horizontal">
            <Switch
              checked={Boolean(field.value)}
              onCheckedChange={field.onChange}
            />
            <FieldContent>
              <FieldLabel>Enabled</FieldLabel>
            </FieldContent>
          </Field>
        )}
      />

      <FormField
        name="imessage.backend"
        render={({ field }) => (
          <Field>
            <FieldLabel>Backend</FieldLabel>
            <NativeSelect
              value={field.value as string}
              onChange={field.onChange}
            >
              <NativeSelectOption value="local">local</NativeSelectOption>
              <NativeSelectOption value="bluebubbles">
                remote
              </NativeSelectOption>
            </NativeSelect>
          </Field>
        )}
      />

      {isRemote ? (
        <>
          <div className="field-grid">
            <FormField
              name="imessage.serverUrl"
              render={({ field }) => (
                <Field>
                  <FieldLabel>Server URL</FieldLabel>
                  <Input {...field} />
                </Field>
              )}
            />
            <ManagedSecretField
              label="Password"
              secretName="IMESSAGE_PASSWORD"
              secretLabel="password"
              configValue={props.draft.imessage.password}
              configured={props.passwordConfigured}
              source={props.passwordSource}
              token={props.token}
              onSecretSaved={props.onSecretSaved}
            />
          </div>

          <FormField
            name="imessage.webhookPath"
            render={({ field }) => (
              <Field>
                <FieldLabel>Webhook path</FieldLabel>
                <Input {...field} />
              </Field>
            )}
          />

          <FormField
            name="imessage.allowPrivateNetwork"
            render={({ field }) => (
              <Field orientation="horizontal">
                <Switch
                  checked={Boolean(field.value)}
                  onCheckedChange={field.onChange}
                />
                <FieldContent>
                  <FieldLabel>Allow private network</FieldLabel>
                </FieldContent>
              </Field>
            )}
          />
        </>
      ) : (
        <div className="field-grid">
          <FormField
            name="imessage.cliPath"
            render={({ field }) => (
              <Field>
                <FieldLabel>CLI path</FieldLabel>
                <Input {...field} />
              </Field>
            )}
          />
          <FormField
            name="imessage.dbPath"
            render={({ field }) => (
              <Field>
                <FieldLabel>Database path</FieldLabel>
                <Input {...field} />
              </Field>
            )}
          />
        </div>
      )}

      <div className="field-grid">
        <FormField
          name="imessage.dmPolicy"
          render={({ field }) => (
            <Field>
              <FieldLabel>DM policy</FieldLabel>
              <NativeSelect
                value={field.value as string}
                onChange={field.onChange}
              >
                <NativeSelectOption value="open">open</NativeSelectOption>
                <NativeSelectOption value="allowlist">
                  allowlist
                </NativeSelectOption>
                <NativeSelectOption value="disabled">
                  disabled
                </NativeSelectOption>
              </NativeSelect>
            </Field>
          )}
        />
        <FormField
          name="imessage.groupPolicy"
          render={({ field }) => (
            <Field>
              <FieldLabel>Group policy</FieldLabel>
              <NativeSelect
                value={field.value as string}
                onChange={field.onChange}
              >
                <NativeSelectOption value="open">open</NativeSelectOption>
                <NativeSelectOption value="allowlist">
                  allowlist
                </NativeSelectOption>
                <NativeSelectOption value="disabled">
                  disabled
                </NativeSelectOption>
              </NativeSelect>
            </Field>
          )}
        />
      </div>

      <FormField
        name="imessage.allowFrom"
        render={({ field }) => (
          <ListField
            label="Allowed DM senders"
            value={field.value as string[]}
            rows={3}
            placeholder="phone, email, or chat:id"
            onChange={field.onChange}
          />
        )}
      />

      <FormField
        name="imessage.groupAllowFrom"
        render={({ field }) => (
          <ListField
            label="Allowed group senders"
            value={field.value as string[]}
            rows={3}
            placeholder="phone, email, or chat:id"
            onChange={field.onChange}
          />
        )}
      />

      <div className="field-grid">
        <FormField
          name="imessage.pollIntervalMs"
          render={({ field }) => (
            <Field>
              <FieldLabel>
                {isRemote ? 'Webhook / poll interval ms' : 'Poll interval ms'}
              </FieldLabel>
              <NumberField
                integer
                min={0}
                value={field.value as number}
                onValueChange={field.onChange}
              />
            </Field>
          )}
        />
        <FormField
          name="imessage.debounceMs"
          render={({ field }) => (
            <Field>
              <FieldLabel>Debounce ms</FieldLabel>
              <NumberField
                integer
                min={0}
                value={field.value as number}
                onValueChange={field.onChange}
              />
            </Field>
          )}
        />
      </div>

      <div className="field-grid">
        <FormField
          name="imessage.textChunkLimit"
          render={({ field }) => (
            <Field>
              <FieldLabel>Text chunk limit</FieldLabel>
              <NumberField
                integer
                min={0}
                value={field.value as number}
                onValueChange={field.onChange}
              />
            </Field>
          )}
        />
        <FormField
          name="imessage.mediaMaxMb"
          render={({ field }) => (
            <Field>
              <FieldLabel>Media max MB</FieldLabel>
              <NumberField
                integer
                min={0}
                value={field.value as number}
                onValueChange={field.onChange}
              />
            </Field>
          )}
        />
      </div>
      <ChannelInstructionsField kind="imessage" />
    </>
  );
}

function renderSelectedEditor(
  kind: ChannelKind,
  draft: AdminConfig,
  form: UseFormControllerReturn<AdminConfig>,
  token: string,
  secretStatus: {
    discord: {
      configured: boolean;
      source: SecretSource;
    };
    slack: {
      botConfigured: boolean;
      botSource: SecretSource;
      appConfigured: boolean;
      appSource: SecretSource;
    };
    telegram: {
      configured: boolean;
      source: SecretSource;
    };
    threema: {
      configured: boolean;
      source: SecretSource;
    };
    voice: {
      configured: boolean;
      source: SecretSource;
    };
    email: {
      configured: boolean;
      source: SecretSource;
    };
    imessage: {
      configured: boolean;
      source: SecretSource;
    };
  },
  hybridaiApiKeyConfigured: boolean,
  whatsappStatus: {
    linked: boolean;
    pairingQrText: string | null;
    pairingError: string | null;
  },
  signalStatus: {
    cliAvailable: boolean;
    cliVersion: string | null;
    cliError: string | null;
  },
  agents: AdminAgent[],
  onConfigSaved: (config: AdminConfig) => void,
  onSecretSaved: () => void,
) {
  switch (kind) {
    case 'discord':
      return (
        <DiscordChannelEditor
          draft={draft}
          form={form}
          tokenConfigured={secretStatus.discord.configured}
          tokenSource={secretStatus.discord.source}
          token={token}
          onSecretSaved={onSecretSaved}
        />
      );
    case 'whatsapp':
      return (
        <WhatsAppChannelEditor
          draft={draft}
          form={form}
          linked={whatsappStatus.linked}
          pairingQrText={whatsappStatus.pairingQrText}
          pairingError={whatsappStatus.pairingError}
        />
      );
    case 'slack':
      return (
        <SlackChannelEditor
          draft={draft}
          form={form}
          botTokenConfigured={secretStatus.slack.botConfigured}
          botTokenSource={secretStatus.slack.botSource}
          appTokenConfigured={secretStatus.slack.appConfigured}
          appTokenSource={secretStatus.slack.appSource}
          token={token}
          onSecretSaved={onSecretSaved}
        />
      );
    case 'slack_webhook':
      return (
        <SlackWebhookChannelEditor
          draft={draft}
          onConfigSaved={onConfigSaved}
          token={token}
          form={form}
        />
      );
    case 'discord_webhook':
      return (
        <DiscordWebhookChannelEditor
          draft={draft}
          onConfigSaved={onConfigSaved}
          token={token}
          form={form}
        />
      );
    case 'telegram':
      return (
        <TelegramChannelEditor
          draft={draft}
          form={form}
          tokenConfigured={secretStatus.telegram.configured}
          tokenSource={secretStatus.telegram.source}
          token={token}
          onSecretSaved={onSecretSaved}
        />
      );
    case 'signal':
      return (
        <SignalChannelEditor
          draft={draft}
          form={form}
          token={token}
          cliAvailable={signalStatus.cliAvailable}
          cliVersion={signalStatus.cliVersion}
          cliError={signalStatus.cliError}
        />
      );
    case 'threema':
      return (
        <ThreemaChannelEditor
          draft={draft}
          form={form}
          secretConfigured={secretStatus.threema.configured}
          secretSource={secretStatus.threema.source}
          token={token}
          onSecretSaved={onSecretSaved}
        />
      );
    case 'voice':
      return (
        <VoiceChannelEditor
          draft={draft}
          form={form}
          authTokenConfigured={secretStatus.voice.configured}
          authTokenSource={secretStatus.voice.source}
          token={token}
          onSecretSaved={onSecretSaved}
        />
      );
    case 'email':
      return (
        <EmailChannelEditor
          draft={draft}
          form={form}
          passwordConfigured={secretStatus.email.configured}
          passwordSource={secretStatus.email.source}
          hybridaiApiKeyConfigured={hybridaiApiKeyConfigured}
          agents={agents}
          token={token}
          onSecretSaved={onSecretSaved}
        />
      );
    case 'msteams':
      return <TeamsChannelEditor draft={draft} form={form} />;
    case 'imessage':
      return (
        <IMessageChannelEditor
          draft={draft}
          form={form}
          passwordConfigured={secretStatus.imessage.configured}
          passwordSource={secretStatus.imessage.source}
          token={token}
          onSecretSaved={onSecretSaved}
        />
      );
  }
}

export function ChannelsPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [selectedKind, setSelectedKind] = useState<ChannelKind | null>(null);

  const configQuery = useQuery({
    queryKey: ['config', auth.token],
    queryFn: () => fetchConfig(auth.token),
  });
  const statusQuery = useQuery({
    queryKey: ['status', auth.token],
    queryFn: () => validateToken(auth.token),
    initialData: auth.gatewayStatus,
    refetchInterval: 3_000,
  });
  const agentsQuery = useQuery({
    queryKey: ['admin-agents', auth.token],
    queryFn: () => fetchAdminAgents(auth.token),
    enabled: selectedKind === 'email',
  });

  const form = useForm<AdminConfig>({
    source: configQuery.data?.config,
  });
  const { draft, isDirty, commit } = form;

  const saveMutation = useFormMutation({
    mutationFn: (nextConfig: AdminConfig) => saveConfig(auth.token, nextConfig),
    onSuccess: (payload) => {
      queryClient.setQueryData(['config', auth.token], payload);
      commit(payload.config);
      toast.success('Channel settings saved.');
    },
    onError: (error) => {
      toast.error('Save failed', error.message);
    },
    invalidates: [['status', auth.token], ['overview']],
  });

  const catalog = draft
    ? buildChannelCatalog(draft, {
        discordTokenConfigured: statusQuery.data?.discord?.tokenConfigured,
        discordWebhookDefaultConfigured:
          statusQuery.data?.discordWebhook?.defaultTargetConfigured,
        slackBotTokenConfigured: statusQuery.data?.slack?.botTokenConfigured,
        slackAppTokenConfigured: statusQuery.data?.slack?.appTokenConfigured,
        slackWebhookDefaultConfigured:
          statusQuery.data?.slackWebhook?.defaultTargetConfigured,
        telegramTokenConfigured: statusQuery.data?.telegram?.tokenConfigured,
        threemaSecretConfigured: statusQuery.data?.threema?.secretConfigured,
        signalDaemonUrlConfigured:
          statusQuery.data?.signal?.daemonUrlConfigured,
        signalAccountConfigured: statusQuery.data?.signal?.accountConfigured,
        signalCliAvailable: statusQuery.data?.signal?.cliAvailable,
        voiceAuthTokenConfigured: statusQuery.data?.voice?.authTokenConfigured,
        whatsappLinked: statusQuery.data?.whatsapp?.linked,
        emailPasswordConfigured: statusQuery.data?.email?.passwordConfigured,
        imessagePasswordConfigured:
          statusQuery.data?.imessage?.passwordConfigured,
      })
    : [];

  useEffect(() => {
    const firstCatalogEntry = catalog[0];
    if (!firstCatalogEntry) return;
    setSelectedKind((current) => {
      if (
        window.location.hash === '#whatsapp' &&
        catalog.some((entry) => entry.kind === 'whatsapp')
      ) {
        return 'whatsapp';
      }
      if (current && catalog.some((entry) => entry.kind === current)) {
        return current;
      }
      return firstCatalogEntry.kind;
    });
  }, [catalog]);

  useEffect(() => {
    if (selectedKind !== 'whatsapp' || window.location.hash !== '#whatsapp') {
      return;
    }
    window.setTimeout(() => {
      const target = document.getElementById('whatsapp');
      if (typeof target?.scrollIntoView === 'function') {
        target.scrollIntoView({ block: 'start' });
      }
    }, 0);
  }, [selectedKind]);

  // Clear any prior save success/error state as soon as the user resumes
  // editing, so a stale toast or button label doesn't follow them around.
  // `saveMutation` itself is left out of deps — its identity changes every
  // render (useMutation returns a fresh object); the `.reset()` callback
  // is stable enough via closure.
  const saveMutationReset = saveMutation.reset;
  useEffect(() => {
    if (isDirty) saveMutationReset();
  }, [isDirty, saveMutationReset]);

  if (configQuery.isLoading && !draft) {
    return <div className="empty-state">Loading channel settings...</div>;
  }

  if (!draft) {
    return <div className="empty-state">Channel settings are unavailable.</div>;
  }

  const selectedChannel =
    catalog.find((entry) => entry.kind === selectedKind) ?? catalog[0] ?? null;
  const secretStatus = {
    discord: {
      configured: statusQuery.data?.discord?.tokenConfigured ?? false,
      source: statusQuery.data?.discord?.tokenSource ?? null,
    },
    slack: {
      botConfigured: statusQuery.data?.slack?.botTokenConfigured ?? false,
      botSource: statusQuery.data?.slack?.botTokenSource ?? null,
      appConfigured: statusQuery.data?.slack?.appTokenConfigured ?? false,
      appSource: statusQuery.data?.slack?.appTokenSource ?? null,
    },
    telegram: {
      configured: statusQuery.data?.telegram?.tokenConfigured ?? false,
      source: statusQuery.data?.telegram?.tokenSource ?? null,
    },
    threema: {
      configured: statusQuery.data?.threema?.secretConfigured ?? false,
      source: statusQuery.data?.threema?.secretSource ?? null,
    },
    voice: {
      configured: statusQuery.data?.voice?.authTokenConfigured ?? false,
      source: statusQuery.data?.voice?.authTokenSource ?? null,
    },
    email: {
      configured: statusQuery.data?.email?.passwordConfigured ?? false,
      source: statusQuery.data?.email?.passwordSource ?? null,
    },
    imessage: {
      configured: statusQuery.data?.imessage?.passwordConfigured ?? false,
      source: statusQuery.data?.imessage?.passwordSource ?? null,
    },
  };
  const whatsappStatus = {
    linked: statusQuery.data?.whatsapp?.linked ?? false,
    pairingQrText: statusQuery.data?.whatsapp?.pairingQrText ?? null,
    pairingError: statusQuery.data?.whatsapp?.pairingError ?? null,
  };
  const signalStatus = {
    cliAvailable: statusQuery.data?.signal?.cliAvailable ?? false,
    cliVersion: statusQuery.data?.signal?.cliVersion ?? null,
    cliError: statusQuery.data?.signal?.cliError ?? null,
  };
  const hybridaiApiKeyConfigured =
    statusQuery.data?.hybridai?.apiKeyConfigured ?? false;

  return (
    <div className="page-stack">
      <div className="two-column-grid channels-layout">
        <Card>
          <div className="list-stack selectable-list channel-catalog">
            {catalog.map((entry) => (
              <button
                key={entry.kind}
                className={
                  entry.kind === selectedChannel?.kind
                    ? 'selectable-row active channel-selectable-row'
                    : 'selectable-row channel-selectable-row'
                }
                type="button"
                onClick={() => setSelectedKind(entry.kind)}
              >
                <div className="channel-row-main">
                  <ChannelLogo kind={entry.kind} />
                  <div className="channel-row-copy">
                    <strong>{entry.label}</strong>
                    <small>{entry.summary}</small>
                  </div>
                </div>
                <div className="row-status-stack">
                  <span
                    className={`channel-status-badge channel-status-${entry.statusTone}`}
                  >
                    {entry.statusLabel}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </Card>

        <Form form={form} onSubmit={() => saveMutation.mutate(draft)}>
          <Card
            id={selectedChannel?.kind === 'whatsapp' ? 'whatsapp' : undefined}
            variant="muted"
          >
            <CardHeader>
              <CardTitle>
                {selectedChannel
                  ? `${selectedChannel.label} settings`
                  : 'Channels'}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="stack-form">
                {selectedChannel
                  ? renderSelectedEditor(
                      selectedChannel.kind,
                      draft,
                      form,
                      auth.token,
                      secretStatus,
                      hybridaiApiKeyConfigured,
                      whatsappStatus,
                      signalStatus,
                      agentsQuery.data || [],
                      (config) => {
                        const payload = {
                          path: configQuery.data?.path || '',
                          config,
                        };
                        queryClient.setQueryData(
                          ['config', auth.token],
                          payload,
                        );
                        commit(config);
                        void queryClient.invalidateQueries({
                          queryKey: ['status', auth.token],
                        });
                      },
                      () => {
                        void queryClient.invalidateQueries({
                          queryKey: ['status', auth.token],
                        });
                      },
                    )
                  : null}

                <div className="button-row">
                  <Button
                    type="submit"
                    loading={saveMutation.isPending}
                    disabled={!isDirty || saveMutation.isPending}
                  >
                    {saveMutation.isPending
                      ? 'Saving...'
                      : 'Save channel settings'}
                  </Button>
                  <Button
                    variant="ghost"
                    type="button"
                    disabled={!isDirty || !configQuery.data}
                    onClick={() => {
                      if (!configQuery.data) return;
                      saveMutation.reset();
                      form.discard();
                    }}
                  >
                    Reset changes
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </Form>
      </div>
    </div>
  );
}
