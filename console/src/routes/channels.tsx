import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
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
import type { AdminConfig } from '../api/types';
import { useAuth } from '../auth';
import { Button } from '../components/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/card';
import { ChannelLogo } from '../components/channel-logo';
import { Field, FieldContent, FieldLabel } from '../components/field';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  type UseFormControllerReturn,
  useForm,
} from '../components/form';
import { Input } from '../components/input';
import { NativeSelect, NativeSelectOption } from '../components/native-select';
import { NumberField } from '../components/number-field';
import { Switch } from '../components/switch';
import { Textarea } from '../components/textarea';
import { useToast } from '../components/toast';
import { useFormMutation } from '../hooks/use-form-mutation';
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

function ChannelInstructionsField(props: { kind: ChannelInstructionKind }) {
  return (
    <FormField
      name={`channelInstructions.${props.kind}`}
      render={({ field }) => (
        <FormItem>
          <FormLabel>Channel instructions</FormLabel>
          <FormControl>
            <Textarea
              rows={4}
              {...field}
              placeholder="Optional extra instructions for this channel only."
            />
          </FormControl>
        </FormItem>
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
    <div className="field managed-secret-field">
      <span>{props.label}</span>
      {!isEditing ? (
        <div className="button-row">
          <Button
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
    </div>
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
      <FormItem orientation="horizontal">
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
          <FormLabel>Enabled</FormLabel>
        </FieldContent>
      </FormItem>

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
            <FormItem>
              <FormLabel>Prefix</FormLabel>
              <FormControl>
                <Input {...field} />
              </FormControl>
            </FormItem>
          )}
        />
        <FormField
          name="discord.groupPolicy"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Group policy</FormLabel>
              <FormControl>
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
              </FormControl>
            </FormItem>
          )}
        />
      </div>

      <FormField
        name="discord.commandsOnly"
        render={({ field }) => (
          <FormItem orientation="horizontal">
            <Switch
              checked={Boolean(field.value)}
              onCheckedChange={field.onChange}
            />
            <FieldContent>
              <FormLabel>Commands only</FormLabel>
            </FieldContent>
          </FormItem>
        )}
      />

      <div className="field-grid">
        <FormField
          name="discord.commandMode"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Command mode</FormLabel>
              <FormControl>
                <NativeSelect
                  value={field.value as string}
                  onChange={field.onChange}
                >
                  <NativeSelectOption value="public">public</NativeSelectOption>
                  <NativeSelectOption value="restricted">
                    restricted
                  </NativeSelectOption>
                </NativeSelect>
              </FormControl>
            </FormItem>
          )}
        />
        <FormField
          name="discord.sendPolicy"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Send policy</FormLabel>
              <FormControl>
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
              </FormControl>
            </FormItem>
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
            <FormItem>
              <FormLabel>Typing mode</FormLabel>
              <FormControl>
                <NativeSelect
                  value={field.value as string}
                  onChange={field.onChange}
                >
                  <NativeSelectOption value="instant">
                    instant
                  </NativeSelectOption>
                  <NativeSelectOption value="thinking">
                    thinking
                  </NativeSelectOption>
                  <NativeSelectOption value="streaming">
                    streaming
                  </NativeSelectOption>
                  <NativeSelectOption value="never">never</NativeSelectOption>
                </NativeSelect>
              </FormControl>
            </FormItem>
          )}
        />
        <FormField
          name="discord.ackReaction"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Ack reaction</FormLabel>
              <FormControl>
                <Input {...field} placeholder="👀" />
              </FormControl>
            </FormItem>
          )}
        />
      </div>

      <div className="field-grid">
        <FormField
          name="discord.ackReactionScope"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Ack reaction scope</FormLabel>
              <FormControl>
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
              </FormControl>
            </FormItem>
          )}
        />
        <FormField
          name="discord.textChunkLimit"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Text chunk limit</FormLabel>
              <FormControl>
                <NumberField
                  integer
                  min={0}
                  value={field.value as number}
                  onValueChange={field.onChange}
                />
              </FormControl>
            </FormItem>
          )}
        />
      </div>

      <div className="field-grid">
        <FormField
          name="discord.debounceMs"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Debounce ms</FormLabel>
              <FormControl>
                <NumberField
                  integer
                  min={0}
                  value={field.value as number}
                  onValueChange={field.onChange}
                />
              </FormControl>
            </FormItem>
          )}
        />
        <FormField
          name="discord.maxLinesPerMessage"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Max lines per message</FormLabel>
              <FormControl>
                <NumberField
                  integer
                  min={0}
                  value={field.value as number}
                  onValueChange={field.onChange}
                />
              </FormControl>
            </FormItem>
          )}
        />
      </div>

      <div className="field-grid">
        <FormField
          name="discord.rateLimitPerUser"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Rate limit per user</FormLabel>
              <FormControl>
                <NumberField
                  integer
                  min={0}
                  value={field.value as number}
                  onValueChange={field.onChange}
                />
              </FormControl>
            </FormItem>
          )}
        />
        <FormField
          name="discord.maxConcurrentPerChannel"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Max concurrent per channel</FormLabel>
              <FormControl>
                <NumberField
                  integer
                  min={0}
                  value={field.value as number}
                  onValueChange={field.onChange}
                />
              </FormControl>
            </FormItem>
          )}
        />
      </div>

      <FormField
        name="discord.removeAckAfterReply"
        render={({ field }) => (
          <FormItem orientation="horizontal">
            <Switch
              checked={Boolean(field.value)}
              onCheckedChange={field.onChange}
            />
            <FieldContent>
              <FormLabel>Remove ack after reply</FormLabel>
            </FieldContent>
          </FormItem>
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
}) {
  return (
    <>
      <FormItem orientation="horizontal">
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
          <FormLabel>Enabled</FormLabel>
        </FieldContent>
      </FormItem>

      <div className="field-grid">
        <FormField
          name="whatsapp.dmPolicy"
          render={({ field }) => (
            <FormItem>
              <FormLabel>DM policy</FormLabel>
              <FormControl>
                <NativeSelect
                  value={field.value as string}
                  onChange={field.onChange}
                >
                  <NativeSelectOption value="open">open</NativeSelectOption>
                  <NativeSelectOption value="pairing">
                    pairing
                  </NativeSelectOption>
                  <NativeSelectOption value="allowlist">
                    allowlist
                  </NativeSelectOption>
                  <NativeSelectOption value="disabled">
                    disabled
                  </NativeSelectOption>
                </NativeSelect>
              </FormControl>
            </FormItem>
          )}
        />
        <FormField
          name="whatsapp.groupPolicy"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Group policy</FormLabel>
              <FormControl>
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
              </FormControl>
            </FormItem>
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
              Waiting for a fresh QR from the gateway.
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
            <FormItem>
              <FormLabel>Debounce ms</FormLabel>
              <FormControl>
                <NumberField
                  integer
                  min={0}
                  value={field.value as number}
                  onValueChange={field.onChange}
                />
              </FormControl>
            </FormItem>
          )}
        />
        <FormField
          name="whatsapp.ackReaction"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Ack reaction</FormLabel>
              <FormControl>
                <Input {...field} />
              </FormControl>
            </FormItem>
          )}
        />
      </div>

      <div className="field-grid">
        <FormField
          name="whatsapp.textChunkLimit"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Text chunk limit</FormLabel>
              <FormControl>
                <NumberField
                  integer
                  min={0}
                  value={field.value as number}
                  onValueChange={field.onChange}
                />
              </FormControl>
            </FormItem>
          )}
        />
        <FormField
          name="whatsapp.mediaMaxMb"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Media max MB</FormLabel>
              <FormControl>
                <NumberField
                  integer
                  min={0}
                  value={field.value as number}
                  onValueChange={field.onChange}
                />
              </FormControl>
            </FormItem>
          )}
        />
      </div>

      <FormField
        name="whatsapp.sendReadReceipts"
        render={({ field }) => (
          <FormItem orientation="horizontal">
            <Switch
              checked={Boolean(field.value)}
              onCheckedChange={field.onChange}
            />
            <FieldContent>
              <FormLabel>Send read receipts</FormLabel>
            </FieldContent>
          </FormItem>
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
          <FormItem orientation="horizontal">
            <Switch
              checked={Boolean(field.value)}
              onCheckedChange={field.onChange}
            />
            <FieldContent>
              <FormLabel>Enabled</FormLabel>
            </FieldContent>
          </FormItem>
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
            <FormItem>
              <FormLabel>Poll interval ms</FormLabel>
              <FormControl>
                <NumberField
                  integer
                  min={0}
                  value={field.value as number}
                  onValueChange={field.onChange}
                />
              </FormControl>
            </FormItem>
          )}
        />
      </div>

      <div className="field-grid">
        <FormField
          name="telegram.dmPolicy"
          render={({ field }) => (
            <FormItem>
              <FormLabel>DM policy</FormLabel>
              <FormControl>
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
              </FormControl>
            </FormItem>
          )}
        />
        <FormField
          name="telegram.groupPolicy"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Group policy</FormLabel>
              <FormControl>
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
              </FormControl>
            </FormItem>
          )}
        />
      </div>

      <FormField
        name="telegram.requireMention"
        render={({ field }) => (
          <FormItem orientation="horizontal">
            <Switch
              checked={Boolean(field.value)}
              onCheckedChange={field.onChange}
            />
            <FieldContent>
              <FormLabel>Require mention in groups</FormLabel>
            </FieldContent>
          </FormItem>
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
            <FormItem>
              <FormLabel>Text chunk limit</FormLabel>
              <FormControl>
                <NumberField
                  integer
                  min={0}
                  value={field.value as number}
                  onValueChange={field.onChange}
                />
              </FormControl>
            </FormItem>
          )}
        />
        <FormField
          name="telegram.mediaMaxMb"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Media max MB</FormLabel>
              <FormControl>
                <NumberField
                  integer
                  min={0}
                  value={field.value as number}
                  onValueChange={field.onChange}
                />
              </FormControl>
            </FormItem>
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
          <FormItem orientation="horizontal">
            <Switch
              checked={Boolean(field.value)}
              onCheckedChange={field.onChange}
            />
            <FieldContent>
              <FormLabel>Enabled</FormLabel>
            </FieldContent>
          </FormItem>
        )}
      />

      <div className="field-grid">
        <FormField
          name="threema.identity"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Gateway identity</FormLabel>
              <FormControl>
                <Input {...field} placeholder="*HYBRID1" />
              </FormControl>
            </FormItem>
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
            <FormItem>
              <FormLabel>API base URL</FormLabel>
              <FormControl>
                <Input {...field} />
              </FormControl>
            </FormItem>
          )}
        />
        <FormField
          name="threema.dmPolicy"
          render={({ field }) => (
            <FormItem>
              <FormLabel>DM policy</FormLabel>
              <FormControl>
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
              </FormControl>
            </FormItem>
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
            <FormItem>
              <FormLabel>Text chunk limit</FormLabel>
              <FormControl>
                <NumberField
                  integer
                  min={0}
                  value={field.value as number}
                  onValueChange={field.onChange}
                />
              </FormControl>
            </FormItem>
          )}
        />
        <FormField
          name="threema.outboundDelayMs"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Outbound delay ms</FormLabel>
              <FormControl>
                <NumberField
                  integer
                  min={0}
                  value={field.value as number}
                  onValueChange={field.onChange}
                />
              </FormControl>
            </FormItem>
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
          <FormItem orientation="horizontal">
            <Switch
              checked={Boolean(field.value)}
              onCheckedChange={field.onChange}
            />
            <FieldContent>
              <FormLabel>Enabled</FormLabel>
            </FieldContent>
          </FormItem>
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
            <FormItem>
              <FormLabel>Daemon URL</FormLabel>
              <FormControl>
                <Input {...field} placeholder="http://127.0.0.1:8080" />
              </FormControl>
            </FormItem>
          )}
        />
        <FormField
          name="signal.account"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Account</FormLabel>
              <FormControl>
                <Input {...field} placeholder="+14155550123" />
              </FormControl>
            </FormItem>
          )}
        />
      </div>

      <div className="field-grid">
        <FormField
          name="signal.dmPolicy"
          render={({ field }) => (
            <FormItem>
              <FormLabel>DM policy</FormLabel>
              <FormControl>
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
              </FormControl>
            </FormItem>
          )}
        />
        <FormField
          name="signal.groupPolicy"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Group policy</FormLabel>
              <FormControl>
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
              </FormControl>
            </FormItem>
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
            <FormItem>
              <FormLabel>Text chunk limit</FormLabel>
              <FormControl>
                <NumberField
                  integer
                  min={0}
                  value={field.value as number}
                  onValueChange={field.onChange}
                />
              </FormControl>
            </FormItem>
          )}
        />
        <FormField
          name="signal.reconnectIntervalMs"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Reconnect interval ms</FormLabel>
              <FormControl>
                <NumberField
                  integer
                  min={0}
                  value={field.value as number}
                  onValueChange={field.onChange}
                />
              </FormControl>
            </FormItem>
          )}
        />
        <FormField
          name="signal.outboundDelayMs"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Outbound delay ms</FormLabel>
              <FormControl>
                <NumberField
                  integer
                  min={0}
                  value={field.value as number}
                  onValueChange={field.onChange}
                />
              </FormControl>
            </FormItem>
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
  token: string;
  onSecretSaved: () => void;
}) {
  const [fetchingEmailConfig, setFetchingEmailConfig] = useState(false);
  const toast = useToast();

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
          <FormItem orientation="horizontal">
            <Switch
              checked={Boolean(field.value)}
              onCheckedChange={field.onChange}
            />
            <FieldContent>
              <FormLabel>Enabled</FormLabel>
            </FieldContent>
          </FormItem>
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

      <div className="field-grid">
        <FormField
          name="email.address"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Address</FormLabel>
              <FormControl>
                <Input {...field} placeholder="bot@example.com" />
              </FormControl>
            </FormItem>
          )}
        />
        <ManagedSecretField
          label="Password"
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
            <FormItem>
              <FormLabel>IMAP host</FormLabel>
              <FormControl>
                <Input {...field} />
              </FormControl>
            </FormItem>
          )}
        />
        <FormField
          name="email.smtpHost"
          render={({ field }) => (
            <FormItem>
              <FormLabel>SMTP host</FormLabel>
              <FormControl>
                <Input {...field} />
              </FormControl>
            </FormItem>
          )}
        />
      </div>

      <div className="field-grid">
        <FormField
          name="email.imapPort"
          render={({ field }) => (
            <FormItem>
              <FormLabel>IMAP port</FormLabel>
              <FormControl>
                <NumberField
                  integer
                  min={0}
                  value={field.value as number}
                  onValueChange={field.onChange}
                />
              </FormControl>
            </FormItem>
          )}
        />
        <FormField
          name="email.smtpPort"
          render={({ field }) => (
            <FormItem>
              <FormLabel>SMTP port</FormLabel>
              <FormControl>
                <NumberField
                  integer
                  min={0}
                  value={field.value as number}
                  onValueChange={field.onChange}
                />
              </FormControl>
            </FormItem>
          )}
        />
      </div>

      <div className="field-grid">
        <FormField
          name="email.imapSecure"
          render={({ field }) => (
            <FormItem orientation="horizontal">
              <Switch
                checked={Boolean(field.value)}
                onCheckedChange={field.onChange}
              />
              <FieldContent>
                <FormLabel>IMAP secure</FormLabel>
              </FieldContent>
            </FormItem>
          )}
        />
        <FormField
          name="email.smtpSecure"
          render={({ field }) => (
            <FormItem orientation="horizontal">
              <Switch
                checked={Boolean(field.value)}
                onCheckedChange={field.onChange}
              />
              <FieldContent>
                <FormLabel>SMTP secure</FormLabel>
              </FieldContent>
            </FormItem>
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
            <FormItem>
              <FormLabel>Poll interval ms</FormLabel>
              <FormControl>
                <NumberField
                  integer
                  min={0}
                  value={field.value as number}
                  onValueChange={field.onChange}
                />
              </FormControl>
            </FormItem>
          )}
        />
        <FormField
          name="email.textChunkLimit"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Text chunk limit</FormLabel>
              <FormControl>
                <NumberField
                  integer
                  min={0}
                  value={field.value as number}
                  onValueChange={field.onChange}
                />
              </FormControl>
            </FormItem>
          )}
        />
      </div>

      <FormField
        name="email.mediaMaxMb"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Media max MB</FormLabel>
            <FormControl>
              <NumberField
                integer
                min={0}
                value={field.value as number}
                onValueChange={field.onChange}
              />
            </FormControl>
          </FormItem>
        )}
      />
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
          <FormItem orientation="horizontal">
            <Switch
              checked={Boolean(field.value)}
              onCheckedChange={field.onChange}
            />
            <FieldContent>
              <FormLabel>Enabled</FormLabel>
            </FieldContent>
          </FormItem>
        )}
      />

      <div className="field-grid">
        <FormField
          name="voice.twilio.accountSid"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Twilio account SID</FormLabel>
              <FormControl>
                <Input {...field} placeholder="AC..." />
              </FormControl>
            </FormItem>
          )}
        />
        <FormField
          name="voice.twilio.fromNumber"
          render={({ field }) => (
            <FormItem>
              <FormLabel>From number</FormLabel>
              <FormControl>
                <Input {...field} placeholder="+14155550123" />
              </FormControl>
            </FormItem>
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
            <FormItem>
              <FormLabel>Webhook path</FormLabel>
              <FormControl>
                <Input {...field} placeholder="/voice" />
              </FormControl>
            </FormItem>
          )}
        />
        <FormField
          name="voice.maxConcurrentCalls"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Max concurrent calls</FormLabel>
              <FormControl>
                <NumberField
                  integer
                  min={0}
                  value={field.value as number}
                  onValueChange={field.onChange}
                />
              </FormControl>
            </FormItem>
          )}
        />
      </div>

      <div className="field-grid">
        <FormField
          name="voice.relay.ttsProvider"
          render={({ field }) => (
            <FormItem>
              <FormLabel>TTS provider</FormLabel>
              <FormControl>
                <NativeSelect
                  value={field.value as string}
                  onChange={field.onChange}
                >
                  <NativeSelectOption value="default">
                    default
                  </NativeSelectOption>
                  <NativeSelectOption value="google">google</NativeSelectOption>
                  <NativeSelectOption value="amazon">amazon</NativeSelectOption>
                </NativeSelect>
              </FormControl>
            </FormItem>
          )}
        />
        <FormField
          name="voice.relay.voice"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Voice</FormLabel>
              <FormControl>
                <Input {...field} placeholder="en-US-Journey-D" />
              </FormControl>
            </FormItem>
          )}
        />
      </div>

      <div className="field-grid">
        <FormField
          name="voice.relay.transcriptionProvider"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Transcription provider</FormLabel>
              <FormControl>
                <NativeSelect
                  value={field.value as string}
                  onChange={field.onChange}
                >
                  <NativeSelectOption value="default">
                    default
                  </NativeSelectOption>
                  <NativeSelectOption value="deepgram">
                    deepgram
                  </NativeSelectOption>
                  <NativeSelectOption value="google">google</NativeSelectOption>
                </NativeSelect>
              </FormControl>
            </FormItem>
          )}
        />
        <FormField
          name="voice.relay.language"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Language</FormLabel>
              <FormControl>
                <Input {...field} placeholder="en-US" />
              </FormControl>
            </FormItem>
          )}
        />
      </div>

      <FormField
        name="voice.relay.interruptible"
        render={({ field }) => (
          <FormItem orientation="horizontal">
            <Switch
              checked={Boolean(field.value)}
              onCheckedChange={field.onChange}
            />
            <FieldContent>
              <FormLabel>Interruptible</FormLabel>
            </FieldContent>
          </FormItem>
        )}
      />

      <FormField
        name="voice.relay.welcomeGreeting"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Welcome greeting</FormLabel>
            <FormControl>
              <Textarea rows={3} {...field} />
            </FormControl>
          </FormItem>
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
          <FormItem orientation="horizontal">
            <Switch
              checked={Boolean(field.value)}
              onCheckedChange={field.onChange}
            />
            <FieldContent>
              <FormLabel>Enabled</FormLabel>
            </FieldContent>
          </FormItem>
        )}
      />

      <div className="field-grid">
        <FormField
          name="msteams.appId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>App ID</FormLabel>
              <FormControl>
                <Input {...field} />
              </FormControl>
            </FormItem>
          )}
        />
        <FormField
          name="msteams.tenantId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Tenant ID</FormLabel>
              <FormControl>
                <Input {...field} />
              </FormControl>
            </FormItem>
          )}
        />
      </div>

      <div className="field-grid">
        <FormField
          name="msteams.webhook.path"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Webhook path</FormLabel>
              <FormControl>
                <Input {...field} />
              </FormControl>
            </FormItem>
          )}
        />
        <FormField
          name="msteams.webhook.port"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Webhook port</FormLabel>
              <FormControl>
                <NumberField
                  integer
                  min={0}
                  max={65535}
                  value={field.value as number}
                  onValueChange={field.onChange}
                />
              </FormControl>
            </FormItem>
          )}
        />
      </div>

      <div className="field-grid">
        <FormField
          name="msteams.dmPolicy"
          render={({ field }) => (
            <FormItem>
              <FormLabel>DM policy</FormLabel>
              <FormControl>
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
              </FormControl>
            </FormItem>
          )}
        />
        <FormField
          name="msteams.groupPolicy"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Group policy</FormLabel>
              <FormControl>
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
              </FormControl>
            </FormItem>
          )}
        />
      </div>

      <div className="field-grid">
        <FormField
          name="msteams.requireMention"
          render={({ field }) => (
            <FormItem orientation="horizontal">
              <Switch
                checked={Boolean(field.value)}
                onCheckedChange={field.onChange}
              />
              <FieldContent>
                <FormLabel>Require mention</FormLabel>
              </FieldContent>
            </FormItem>
          )}
        />
        <FormField
          name="msteams.replyStyle"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Reply style</FormLabel>
              <FormControl>
                <NativeSelect
                  value={field.value as string}
                  onChange={field.onChange}
                >
                  <NativeSelectOption value="thread">thread</NativeSelectOption>
                  <NativeSelectOption value="top-level">
                    top-level
                  </NativeSelectOption>
                </NativeSelect>
              </FormControl>
            </FormItem>
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
            <FormItem>
              <FormLabel>Text chunk limit</FormLabel>
              <FormControl>
                <NumberField
                  integer
                  min={0}
                  value={field.value as number}
                  onValueChange={field.onChange}
                />
              </FormControl>
            </FormItem>
          )}
        />
        <FormField
          name="msteams.mediaMaxMb"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Media max MB</FormLabel>
              <FormControl>
                <NumberField
                  integer
                  min={0}
                  value={field.value as number}
                  onValueChange={field.onChange}
                />
              </FormControl>
            </FormItem>
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
          <FormItem orientation="horizontal">
            <Switch
              checked={Boolean(field.value)}
              onCheckedChange={field.onChange}
            />
            <FieldContent>
              <FormLabel>Enabled</FormLabel>
            </FieldContent>
          </FormItem>
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
            <FormItem>
              <FormLabel>DM policy</FormLabel>
              <FormControl>
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
              </FormControl>
            </FormItem>
          )}
        />
        <FormField
          name="slack.groupPolicy"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Group policy</FormLabel>
              <FormControl>
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
              </FormControl>
            </FormItem>
          )}
        />
      </div>

      <div className="field-grid">
        <FormField
          name="slack.requireMention"
          render={({ field }) => (
            <FormItem orientation="horizontal">
              <Switch
                checked={Boolean(field.value)}
                onCheckedChange={field.onChange}
              />
              <FieldContent>
                <FormLabel>Require mention</FormLabel>
              </FieldContent>
            </FormItem>
          )}
        />
        <FormField
          name="slack.replyStyle"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Reply style</FormLabel>
              <FormControl>
                <NativeSelect
                  value={field.value as string}
                  onChange={field.onChange}
                >
                  <NativeSelectOption value="thread">thread</NativeSelectOption>
                  <NativeSelectOption value="top-level">
                    top-level
                  </NativeSelectOption>
                </NativeSelect>
              </FormControl>
            </FormItem>
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
            <FormItem>
              <FormLabel>Text chunk limit</FormLabel>
              <FormControl>
                <NumberField
                  integer
                  min={0}
                  value={field.value as number}
                  onValueChange={field.onChange}
                />
              </FormControl>
            </FormItem>
          )}
        />
        <FormField
          name="slack.mediaMaxMb"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Media max MB</FormLabel>
              <FormControl>
                <NumberField
                  integer
                  min={0}
                  value={field.value as number}
                  onValueChange={field.onChange}
                />
              </FormControl>
            </FormItem>
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
          <FormItem orientation="horizontal">
            <Switch
              checked={Boolean(field.value)}
              onCheckedChange={field.onChange}
            />
            <FieldContent>
              <FormLabel>Enabled</FormLabel>
            </FieldContent>
          </FormItem>
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
          <FormItem orientation="horizontal">
            <Switch
              checked={Boolean(field.value)}
              onCheckedChange={field.onChange}
            />
            <FieldContent>
              <FormLabel>Enabled</FormLabel>
            </FieldContent>
          </FormItem>
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
          <FormItem orientation="horizontal">
            <Switch
              checked={Boolean(field.value)}
              onCheckedChange={field.onChange}
            />
            <FieldContent>
              <FormLabel>Enabled</FormLabel>
            </FieldContent>
          </FormItem>
        )}
      />

      <FormField
        name="imessage.backend"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Backend</FormLabel>
            <FormControl>
              <NativeSelect
                value={field.value as string}
                onChange={field.onChange}
              >
                <NativeSelectOption value="local">local</NativeSelectOption>
                <NativeSelectOption value="bluebubbles">
                  remote
                </NativeSelectOption>
              </NativeSelect>
            </FormControl>
          </FormItem>
        )}
      />

      {isRemote ? (
        <>
          <div className="field-grid">
            <FormField
              name="imessage.serverUrl"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Server URL</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                </FormItem>
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
              <FormItem>
                <FormLabel>Webhook path</FormLabel>
                <FormControl>
                  <Input {...field} />
                </FormControl>
              </FormItem>
            )}
          />

          <FormField
            name="imessage.allowPrivateNetwork"
            render={({ field }) => (
              <FormItem orientation="horizontal">
                <Switch
                  checked={Boolean(field.value)}
                  onCheckedChange={field.onChange}
                />
                <FieldContent>
                  <FormLabel>Allow private network</FormLabel>
                </FieldContent>
              </FormItem>
            )}
          />
        </>
      ) : (
        <div className="field-grid">
          <FormField
            name="imessage.cliPath"
            render={({ field }) => (
              <FormItem>
                <FormLabel>CLI path</FormLabel>
                <FormControl>
                  <Input {...field} />
                </FormControl>
              </FormItem>
            )}
          />
          <FormField
            name="imessage.dbPath"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Database path</FormLabel>
                <FormControl>
                  <Input {...field} />
                </FormControl>
              </FormItem>
            )}
          />
        </div>
      )}

      <div className="field-grid">
        <FormField
          name="imessage.dmPolicy"
          render={({ field }) => (
            <FormItem>
              <FormLabel>DM policy</FormLabel>
              <FormControl>
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
              </FormControl>
            </FormItem>
          )}
        />
        <FormField
          name="imessage.groupPolicy"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Group policy</FormLabel>
              <FormControl>
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
              </FormControl>
            </FormItem>
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
            <FormItem>
              <FormLabel>
                {isRemote ? 'Webhook / poll interval ms' : 'Poll interval ms'}
              </FormLabel>
              <FormControl>
                <NumberField
                  integer
                  min={0}
                  value={field.value as number}
                  onValueChange={field.onChange}
                />
              </FormControl>
            </FormItem>
          )}
        />
        <FormField
          name="imessage.debounceMs"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Debounce ms</FormLabel>
              <FormControl>
                <NumberField
                  integer
                  min={0}
                  value={field.value as number}
                  onValueChange={field.onChange}
                />
              </FormControl>
            </FormItem>
          )}
        />
      </div>

      <div className="field-grid">
        <FormField
          name="imessage.textChunkLimit"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Text chunk limit</FormLabel>
              <FormControl>
                <NumberField
                  integer
                  min={0}
                  value={field.value as number}
                  onValueChange={field.onChange}
                />
              </FormControl>
            </FormItem>
          )}
        />
        <FormField
          name="imessage.mediaMaxMb"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Media max MB</FormLabel>
              <FormControl>
                <NumberField
                  integer
                  min={0}
                  value={field.value as number}
                  onValueChange={field.onChange}
                />
              </FormControl>
            </FormItem>
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
  },
  signalStatus: {
    cliAvailable: boolean;
    cliVersion: string | null;
    cliError: string | null;
  },
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
      if (current && catalog.some((entry) => entry.kind === current)) {
        return current;
      }
      return firstCatalogEntry.kind;
    });
  }, [catalog]);

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
          <Card variant="muted">
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
