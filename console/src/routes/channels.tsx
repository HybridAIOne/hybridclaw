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
import { NumberField } from '../components/number-field';
import { Switch } from '../components/switch';
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

type ConfigUpdater = (updater: (current: AdminConfig) => AdminConfig) => void;
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

function isSlackEnabled(config: AdminConfig): boolean {
  return config.slack.enabled;
}

function isTelegramInboundEnabled(config: AdminConfig): boolean {
  return (
    config.telegram.dmPolicy !== 'disabled' ||
    config.telegram.groupPolicy !== 'disabled'
  );
}

function isSignalEnabled(config: AdminConfig): boolean {
  return config.signal.enabled;
}

function isVoiceEnabled(config: AdminConfig): boolean {
  return config.voice.enabled;
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
      <textarea
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

function ChannelInstructionsField(props: {
  kind: ChannelInstructionKind;
  draft: AdminConfig;
  updateDraft: ConfigUpdater;
}) {
  return (
    <label className="field textarea-field">
      <span>Channel instructions</span>
      <textarea
        rows={4}
        value={props.draft.channelInstructions[props.kind]}
        onChange={(event) =>
          props.updateDraft((current) => ({
            ...current,
            channelInstructions: {
              ...current.channelInstructions,
              [props.kind]: event.target.value,
            },
          }))
        }
        placeholder="Optional extra instructions for this channel only."
      />
    </label>
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
          <label className="field">
            <span>{`New ${props.secretLabel}`}</span>
            <input
              type="password"
              value={nextValue}
              autoComplete="new-password"
              onChange={(event) => setNextValue(event.target.value)}
            />
          </label>

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
  updateDraft: ConfigUpdater;
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
          onCheckedChange={(enabled) =>
            props.updateDraft((current) => ({
              ...current,
              discord: {
                ...current.discord,
                groupPolicy:
                  enabled &&
                  current.discord.groupPolicy === 'disabled' &&
                  !current.discord.commandsOnly
                    ? 'open'
                    : enabled
                      ? current.discord.groupPolicy
                      : 'disabled',
                commandsOnly: enabled ? current.discord.commandsOnly : false,
              },
            }))
          }
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
        <label className="field">
          <span>Prefix</span>
          <input
            value={props.draft.discord.prefix}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                discord: {
                  ...current.discord,
                  prefix: event.target.value,
                },
              }))
            }
          />
        </label>
        <label className="field">
          <span>Group policy</span>
          <select
            value={props.draft.discord.groupPolicy}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                discord: {
                  ...current.discord,
                  groupPolicy: event.target
                    .value as AdminConfig['discord']['groupPolicy'],
                },
              }))
            }
          >
            <option value="open">open</option>
            <option value="allowlist">allowlist</option>
            <option value="disabled">disabled</option>
          </select>
        </label>
      </div>

      <Field orientation="horizontal">
        <Switch
          checked={props.draft.discord.commandsOnly}
          onCheckedChange={(commandsOnly) =>
            props.updateDraft((current) => ({
              ...current,
              discord: {
                ...current.discord,
                commandsOnly,
              },
            }))
          }
        />
        <FieldContent>
          <FieldLabel>Commands only</FieldLabel>
        </FieldContent>
      </Field>

      <div className="field-grid">
        <label className="field">
          <span>Command mode</span>
          <select
            value={props.draft.discord.commandMode}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                discord: {
                  ...current.discord,
                  commandMode: event.target
                    .value as AdminConfig['discord']['commandMode'],
                },
              }))
            }
          >
            <option value="public">public</option>
            <option value="restricted">restricted</option>
          </select>
        </label>
        <label className="field">
          <span>Send policy</span>
          <select
            value={props.draft.discord.sendPolicy}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                discord: {
                  ...current.discord,
                  sendPolicy: event.target
                    .value as AdminConfig['discord']['sendPolicy'],
                },
              }))
            }
          >
            <option value="open">open</option>
            <option value="allowlist">allowlist</option>
            <option value="disabled">disabled</option>
          </select>
        </label>
      </div>

      <ListField
        label="Allowed command user IDs"
        value={props.draft.discord.commandAllowedUserIds}
        rows={3}
        placeholder="comma or newline separated"
        onChange={(commandAllowedUserIds) =>
          props.updateDraft((current) => ({
            ...current,
            discord: {
              ...current.discord,
              commandAllowedUserIds,
            },
          }))
        }
      />

      <ListField
        label="Allowed outbound channel IDs"
        value={props.draft.discord.sendAllowedChannelIds}
        rows={3}
        placeholder="comma or newline separated"
        onChange={(sendAllowedChannelIds) =>
          props.updateDraft((current) => ({
            ...current,
            discord: {
              ...current.discord,
              sendAllowedChannelIds,
            },
          }))
        }
      />

      <ListField
        label="Free response channel IDs"
        value={props.draft.discord.freeResponseChannels}
        rows={3}
        placeholder="comma or newline separated"
        onChange={(freeResponseChannels) =>
          props.updateDraft((current) => ({
            ...current,
            discord: {
              ...current.discord,
              freeResponseChannels,
            },
          }))
        }
      />

      <div className="field-grid">
        <label className="field">
          <span>Typing mode</span>
          <select
            value={props.draft.discord.typingMode}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                discord: {
                  ...current.discord,
                  typingMode: event.target
                    .value as AdminConfig['discord']['typingMode'],
                },
              }))
            }
          >
            <option value="instant">instant</option>
            <option value="thinking">thinking</option>
            <option value="streaming">streaming</option>
            <option value="never">never</option>
          </select>
        </label>
        <label className="field">
          <span>Ack reaction</span>
          <input
            value={props.draft.discord.ackReaction}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                discord: {
                  ...current.discord,
                  ackReaction: event.target.value,
                },
              }))
            }
            placeholder="👀"
          />
        </label>
      </div>

      <div className="field-grid">
        <label className="field">
          <span>Ack reaction scope</span>
          <select
            value={props.draft.discord.ackReactionScope}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                discord: {
                  ...current.discord,
                  ackReactionScope: event.target
                    .value as AdminConfig['discord']['ackReactionScope'],
                },
              }))
            }
          >
            <option value="all">all</option>
            <option value="group-mentions">group-mentions</option>
            <option value="direct">direct</option>
            <option value="off">off</option>
          </select>
        </label>
        <label className="field">
          <span>Text chunk limit</span>
          <NumberField
            integer
            min={0}
            value={props.draft.discord.textChunkLimit}
            onValueChange={(textChunkLimit) =>
              props.updateDraft((current) => ({
                ...current,
                discord: {
                  ...current.discord,
                  textChunkLimit,
                },
              }))
            }
          />
        </label>
      </div>

      <div className="field-grid">
        <label className="field">
          <span>Debounce ms</span>
          <NumberField
            integer
            min={0}
            value={props.draft.discord.debounceMs}
            onValueChange={(debounceMs) =>
              props.updateDraft((current) => ({
                ...current,
                discord: {
                  ...current.discord,
                  debounceMs,
                },
              }))
            }
          />
        </label>
        <label className="field">
          <span>Max lines per message</span>
          <NumberField
            integer
            min={0}
            value={props.draft.discord.maxLinesPerMessage}
            onValueChange={(maxLinesPerMessage) =>
              props.updateDraft((current) => ({
                ...current,
                discord: {
                  ...current.discord,
                  maxLinesPerMessage,
                },
              }))
            }
          />
        </label>
      </div>

      <div className="field-grid">
        <label className="field">
          <span>Rate limit per user</span>
          <NumberField
            integer
            min={0}
            value={props.draft.discord.rateLimitPerUser}
            onValueChange={(rateLimitPerUser) =>
              props.updateDraft((current) => ({
                ...current,
                discord: {
                  ...current.discord,
                  rateLimitPerUser,
                },
              }))
            }
          />
        </label>
        <label className="field">
          <span>Max concurrent per channel</span>
          <NumberField
            integer
            min={0}
            value={props.draft.discord.maxConcurrentPerChannel}
            onValueChange={(maxConcurrentPerChannel) =>
              props.updateDraft((current) => ({
                ...current,
                discord: {
                  ...current.discord,
                  maxConcurrentPerChannel,
                },
              }))
            }
          />
        </label>
      </div>

      <Field orientation="horizontal">
        <Switch
          checked={props.draft.discord.removeAckAfterReply}
          onCheckedChange={(removeAckAfterReply) =>
            props.updateDraft((current) => ({
              ...current,
              discord: {
                ...current.discord,
                removeAckAfterReply,
              },
            }))
          }
        />
        <FieldContent>
          <FieldLabel>Remove ack after reply</FieldLabel>
        </FieldContent>
      </Field>
      <ChannelInstructionsField
        kind="discord"
        draft={props.draft}
        updateDraft={props.updateDraft}
      />
      <p className="muted-copy">
        Discord guild defaults and explicit per-channel overrides stay intact.
        This page edits the transport defaults that apply across the space.
      </p>
    </>
  );
}

function WhatsAppChannelEditor(props: {
  draft: AdminConfig;
  updateDraft: ConfigUpdater;
  linked: boolean;
  pairingQrText: string | null;
}) {
  return (
    <>
      <Field orientation="horizontal">
        <Switch
          checked={isWhatsAppEnabled(props.draft)}
          onCheckedChange={(enabled) =>
            props.updateDraft((current) => ({
              ...current,
              whatsapp: {
                ...current.whatsapp,
                dmPolicy:
                  enabled && current.whatsapp.dmPolicy === 'disabled'
                    ? 'pairing'
                    : enabled
                      ? current.whatsapp.dmPolicy
                      : 'disabled',
                groupPolicy: enabled
                  ? current.whatsapp.groupPolicy
                  : 'disabled',
              },
            }))
          }
        />
        <FieldContent>
          <FieldLabel>Enabled</FieldLabel>
        </FieldContent>
      </Field>

      <div className="field-grid">
        <label className="field">
          <span>DM policy</span>
          <select
            value={props.draft.whatsapp.dmPolicy}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                whatsapp: {
                  ...current.whatsapp,
                  dmPolicy: event.target
                    .value as AdminConfig['whatsapp']['dmPolicy'],
                },
              }))
            }
          >
            <option value="open">open</option>
            <option value="pairing">pairing</option>
            <option value="allowlist">allowlist</option>
            <option value="disabled">disabled</option>
          </select>
        </label>
        <label className="field">
          <span>Group policy</span>
          <select
            value={props.draft.whatsapp.groupPolicy}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                whatsapp: {
                  ...current.whatsapp,
                  groupPolicy: event.target
                    .value as AdminConfig['whatsapp']['groupPolicy'],
                },
              }))
            }
          >
            <option value="open">open</option>
            <option value="allowlist">allowlist</option>
            <option value="disabled">disabled</option>
          </select>
        </label>
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

      <ListField
        label="Allowed DM senders"
        value={props.draft.whatsapp.allowFrom}
        rows={3}
        placeholder="comma or newline separated"
        onChange={(allowFrom) =>
          props.updateDraft((current) => ({
            ...current,
            whatsapp: {
              ...current.whatsapp,
              allowFrom,
            },
          }))
        }
      />

      <ListField
        label="Allowed group senders"
        value={props.draft.whatsapp.groupAllowFrom}
        rows={3}
        placeholder="comma or newline separated"
        onChange={(groupAllowFrom) =>
          props.updateDraft((current) => ({
            ...current,
            whatsapp: {
              ...current.whatsapp,
              groupAllowFrom,
            },
          }))
        }
      />

      <div className="field-grid">
        <label className="field">
          <span>Debounce ms</span>
          <NumberField
            integer
            min={0}
            value={props.draft.whatsapp.debounceMs}
            onValueChange={(debounceMs) =>
              props.updateDraft((current) => ({
                ...current,
                whatsapp: {
                  ...current.whatsapp,
                  debounceMs,
                },
              }))
            }
          />
        </label>
        <label className="field">
          <span>Ack reaction</span>
          <input
            value={props.draft.whatsapp.ackReaction}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                whatsapp: {
                  ...current.whatsapp,
                  ackReaction: event.target.value,
                },
              }))
            }
          />
        </label>
      </div>

      <div className="field-grid">
        <label className="field">
          <span>Text chunk limit</span>
          <NumberField
            integer
            min={0}
            value={props.draft.whatsapp.textChunkLimit}
            onValueChange={(textChunkLimit) =>
              props.updateDraft((current) => ({
                ...current,
                whatsapp: {
                  ...current.whatsapp,
                  textChunkLimit,
                },
              }))
            }
          />
        </label>
        <label className="field">
          <span>Media max MB</span>
          <NumberField
            integer
            min={0}
            value={props.draft.whatsapp.mediaMaxMb}
            onValueChange={(mediaMaxMb) =>
              props.updateDraft((current) => ({
                ...current,
                whatsapp: {
                  ...current.whatsapp,
                  mediaMaxMb,
                },
              }))
            }
          />
        </label>
      </div>

      <Field orientation="horizontal">
        <Switch
          checked={props.draft.whatsapp.sendReadReceipts}
          onCheckedChange={(sendReadReceipts) =>
            props.updateDraft((current) => ({
              ...current,
              whatsapp: {
                ...current.whatsapp,
                sendReadReceipts,
              },
            }))
          }
        />
        <FieldContent>
          <FieldLabel>Send read receipts</FieldLabel>
        </FieldContent>
      </Field>
      <ChannelInstructionsField
        kind="whatsapp"
        draft={props.draft}
        updateDraft={props.updateDraft}
      />
    </>
  );
}

function TelegramChannelEditor(props: {
  draft: AdminConfig;
  updateDraft: ConfigUpdater;
  tokenConfigured: boolean;
  tokenSource: SecretSource;
  token: string;
  onSecretSaved: () => void;
}) {
  return (
    <>
      <Field orientation="horizontal">
        <Switch
          checked={props.draft.telegram.enabled}
          onCheckedChange={(enabled) =>
            props.updateDraft((current) => ({
              ...current,
              telegram: {
                ...current.telegram,
                enabled,
              },
            }))
          }
        />
        <FieldContent>
          <FieldLabel>Enabled</FieldLabel>
        </FieldContent>
      </Field>

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
        <label className="field">
          <span>Poll interval ms</span>
          <NumberField
            integer
            min={0}
            value={props.draft.telegram.pollIntervalMs}
            onValueChange={(pollIntervalMs) =>
              props.updateDraft((current) => ({
                ...current,
                telegram: {
                  ...current.telegram,
                  pollIntervalMs,
                },
              }))
            }
          />
        </label>
      </div>

      <div className="field-grid">
        <label className="field">
          <span>DM policy</span>
          <select
            value={props.draft.telegram.dmPolicy}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                telegram: {
                  ...current.telegram,
                  dmPolicy: event.target
                    .value as AdminConfig['telegram']['dmPolicy'],
                },
              }))
            }
          >
            <option value="open">open</option>
            <option value="allowlist">allowlist</option>
            <option value="disabled">disabled</option>
          </select>
        </label>
        <label className="field">
          <span>Group policy</span>
          <select
            value={props.draft.telegram.groupPolicy}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                telegram: {
                  ...current.telegram,
                  groupPolicy: event.target
                    .value as AdminConfig['telegram']['groupPolicy'],
                },
              }))
            }
          >
            <option value="open">open</option>
            <option value="allowlist">allowlist</option>
            <option value="disabled">disabled</option>
          </select>
        </label>
      </div>

      <Field orientation="horizontal">
        <Switch
          checked={props.draft.telegram.requireMention}
          onCheckedChange={(requireMention) =>
            props.updateDraft((current) => ({
              ...current,
              telegram: {
                ...current.telegram,
                requireMention,
              },
            }))
          }
        />
        <FieldContent>
          <FieldLabel>Require mention in groups</FieldLabel>
        </FieldContent>
      </Field>

      <ListField
        label="Allowed DM senders"
        value={props.draft.telegram.allowFrom}
        rows={3}
        placeholder="numeric user id, @username, or *"
        onChange={(allowFrom) =>
          props.updateDraft((current) => ({
            ...current,
            telegram: {
              ...current.telegram,
              allowFrom,
            },
          }))
        }
      />

      <ListField
        label="Allowed group senders"
        value={props.draft.telegram.groupAllowFrom}
        rows={3}
        placeholder="numeric user id, @username, or *"
        onChange={(groupAllowFrom) =>
          props.updateDraft((current) => ({
            ...current,
            telegram: {
              ...current.telegram,
              groupAllowFrom,
            },
          }))
        }
      />

      <div className="field-grid">
        <label className="field">
          <span>Text chunk limit</span>
          <NumberField
            integer
            min={0}
            value={props.draft.telegram.textChunkLimit}
            onValueChange={(textChunkLimit) =>
              props.updateDraft((current) => ({
                ...current,
                telegram: {
                  ...current.telegram,
                  textChunkLimit,
                },
              }))
            }
          />
        </label>
        <label className="field">
          <span>Media max MB</span>
          <NumberField
            integer
            min={0}
            value={props.draft.telegram.mediaMaxMb}
            onValueChange={(mediaMaxMb) =>
              props.updateDraft((current) => ({
                ...current,
                telegram: {
                  ...current.telegram,
                  mediaMaxMb,
                },
              }))
            }
          />
        </label>
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
      <ChannelInstructionsField
        kind="telegram"
        draft={props.draft}
        updateDraft={props.updateDraft}
      />
    </>
  );
}

function ThreemaChannelEditor(props: {
  draft: AdminConfig;
  updateDraft: ConfigUpdater;
  secretConfigured: boolean;
  secretSource: SecretSource;
  token: string;
  onSecretSaved: () => void;
}) {
  return (
    <>
      <Field orientation="horizontal">
        <Switch
          checked={props.draft.threema.enabled}
          onCheckedChange={(enabled) =>
            props.updateDraft((current) => ({
              ...current,
              threema: {
                ...current.threema,
                enabled,
              },
            }))
          }
        />
        <FieldContent>
          <FieldLabel>Enabled</FieldLabel>
        </FieldContent>
      </Field>

      <div className="field-grid">
        <label className="field">
          <span>Gateway identity</span>
          <input
            value={props.draft.threema.identity}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                threema: {
                  ...current.threema,
                  identity: event.target.value,
                },
              }))
            }
            placeholder="*HYBRID1"
          />
        </label>
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
        <label className="field">
          <span>API base URL</span>
          <input
            value={props.draft.threema.apiBaseUrl}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                threema: {
                  ...current.threema,
                  apiBaseUrl: event.target.value,
                },
              }))
            }
          />
        </label>
        <label className="field">
          <span>DM policy</span>
          <select
            value={props.draft.threema.dmPolicy}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                threema: {
                  ...current.threema,
                  dmPolicy: event.target
                    .value as AdminConfig['threema']['dmPolicy'],
                },
              }))
            }
          >
            <option value="open">open</option>
            <option value="allowlist">allowlist</option>
            <option value="disabled">disabled</option>
          </select>
        </label>
      </div>

      <ListField
        label="Allowed senders"
        value={props.draft.threema.allowFrom}
        rows={3}
        placeholder="threema:ABCDEFGH, threema:phone:41791234567, or *"
        onChange={(allowFrom) =>
          props.updateDraft((current) => ({
            ...current,
            threema: {
              ...current.threema,
              allowFrom,
            },
          }))
        }
      />

      <div className="field-grid">
        <label className="field">
          <span>Text chunk limit</span>
          <NumberField
            integer
            min={0}
            value={props.draft.threema.textChunkLimit}
            onValueChange={(textChunkLimit) =>
              props.updateDraft((current) => ({
                ...current,
                threema: {
                  ...current.threema,
                  textChunkLimit,
                },
              }))
            }
          />
        </label>
        <label className="field">
          <span>Outbound delay ms</span>
          <NumberField
            integer
            min={0}
            value={props.draft.threema.outboundDelayMs}
            onValueChange={(outboundDelayMs) =>
              props.updateDraft((current) => ({
                ...current,
                threema: {
                  ...current.threema,
                  outboundDelayMs,
                },
              }))
            }
          />
        </label>
      </div>

      <p className="muted-copy">
        Threema Gateway Basic mode supports outbound text only. Inbound chat
        history, typing, and attachments are not available.
      </p>
      <ChannelInstructionsField
        kind="threema"
        draft={props.draft}
        updateDraft={props.updateDraft}
      />
    </>
  );
}

function SignalChannelEditor(props: {
  draft: AdminConfig;
  updateDraft: ConfigUpdater;
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
      <Field orientation="horizontal">
        <Switch
          checked={isSignalEnabled(props.draft)}
          onCheckedChange={(enabled) =>
            props.updateDraft((current) => ({
              ...current,
              signal: {
                ...current.signal,
                enabled,
              },
            }))
          }
        />
        <FieldContent>
          <FieldLabel>Enabled</FieldLabel>
        </FieldContent>
      </Field>

      <div className="field-grid">
        <label className="field">
          <span>signal-cli path</span>
          <input
            value={signalCliPath}
            onChange={(event) => setSignalCliPath(event.target.value)}
            placeholder="signal-cli"
          />
        </label>
        <label className="field">
          <span>Device name</span>
          <input
            value={deviceName}
            onChange={(event) => setDeviceName(event.target.value)}
            placeholder="HybridClaw"
          />
        </label>
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
        <label className="field">
          <span>Daemon URL</span>
          <input
            value={props.draft.signal.daemonUrl}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                signal: {
                  ...current.signal,
                  daemonUrl: event.target.value,
                },
              }))
            }
            placeholder="http://127.0.0.1:8080"
          />
        </label>
        <label className="field">
          <span>Account</span>
          <input
            value={props.draft.signal.account}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                signal: {
                  ...current.signal,
                  account: event.target.value,
                },
              }))
            }
            placeholder="+14155550123"
          />
        </label>
      </div>

      <div className="field-grid">
        <label className="field">
          <span>DM policy</span>
          <select
            value={props.draft.signal.dmPolicy}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                signal: {
                  ...current.signal,
                  dmPolicy: event.target
                    .value as AdminConfig['signal']['dmPolicy'],
                },
              }))
            }
          >
            <option value="open">open</option>
            <option value="allowlist">allowlist</option>
            <option value="disabled">disabled</option>
          </select>
        </label>
        <label className="field">
          <span>Group policy</span>
          <select
            value={props.draft.signal.groupPolicy}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                signal: {
                  ...current.signal,
                  groupPolicy: event.target
                    .value as AdminConfig['signal']['groupPolicy'],
                },
              }))
            }
          >
            <option value="open">open</option>
            <option value="allowlist">allowlist</option>
            <option value="disabled">disabled</option>
          </select>
        </label>
      </div>

      <ListField
        label="Allowed DM senders"
        value={props.draft.signal.allowFrom}
        rows={3}
        placeholder="+14155551212, Signal UUID, or *"
        onChange={(allowFrom) =>
          props.updateDraft((current) => ({
            ...current,
            signal: {
              ...current.signal,
              allowFrom,
            },
          }))
        }
      />

      <ListField
        label="Allowed group senders"
        value={props.draft.signal.groupAllowFrom}
        rows={3}
        placeholder="+14155551212, Signal UUID, or *"
        onChange={(groupAllowFrom) =>
          props.updateDraft((current) => ({
            ...current,
            signal: {
              ...current.signal,
              groupAllowFrom,
            },
          }))
        }
      />

      <div className="field-grid">
        <label className="field">
          <span>Text chunk limit</span>
          <NumberField
            integer
            min={0}
            value={props.draft.signal.textChunkLimit}
            onValueChange={(textChunkLimit) =>
              props.updateDraft((current) => ({
                ...current,
                signal: {
                  ...current.signal,
                  textChunkLimit,
                },
              }))
            }
          />
        </label>
        <label className="field">
          <span>Reconnect interval ms</span>
          <NumberField
            integer
            min={0}
            value={props.draft.signal.reconnectIntervalMs}
            onValueChange={(reconnectIntervalMs) =>
              props.updateDraft((current) => ({
                ...current,
                signal: {
                  ...current.signal,
                  reconnectIntervalMs,
                },
              }))
            }
          />
        </label>
        <label className="field">
          <span>Outbound delay ms</span>
          <NumberField
            integer
            min={0}
            value={props.draft.signal.outboundDelayMs}
            onValueChange={(outboundDelayMs) =>
              props.updateDraft((current) => ({
                ...current,
                signal: {
                  ...current.signal,
                  outboundDelayMs,
                },
              }))
            }
          />
        </label>
      </div>

      <p className="muted-copy">
        After scanning the QR in Signal mobile, start the daemon and save the
        daemon URL here. Groups stay disabled by default; start with one
        allowlisted DM sender.
      </p>
      <ChannelInstructionsField
        kind="signal"
        draft={props.draft}
        updateDraft={props.updateDraft}
      />
    </>
  );
}

function EmailChannelEditor(props: {
  draft: AdminConfig;
  updateDraft: ConfigUpdater;
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

      props.updateDraft((current) => ({
        ...current,
        email: {
          ...current.email,
          ...(creds.email ? { address: creds.email } : {}),
          ...(creds.imap_host ? { imapHost: creds.imap_host } : {}),
          ...(creds.imap_port != null ? { imapPort: creds.imap_port } : {}),
          ...(creds.smtp_host ? { smtpHost: creds.smtp_host } : {}),
          ...(creds.smtp_port != null ? { smtpPort: creds.smtp_port } : {}),
        },
      }));

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
      <Field orientation="horizontal">
        <Switch
          checked={props.draft.email.enabled}
          onCheckedChange={(enabled) =>
            props.updateDraft((current) => ({
              ...current,
              email: {
                ...current.email,
                enabled,
              },
            }))
          }
        />
        <FieldContent>
          <FieldLabel>Enabled</FieldLabel>
        </FieldContent>
      </Field>

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
        <label className="field">
          <span>Address</span>
          <input
            value={props.draft.email.address}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                email: {
                  ...current.email,
                  address: event.target.value,
                },
              }))
            }
            placeholder="bot@example.com"
          />
        </label>
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
        <label className="field">
          <span>IMAP host</span>
          <input
            value={props.draft.email.imapHost}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                email: {
                  ...current.email,
                  imapHost: event.target.value,
                },
              }))
            }
          />
        </label>
        <label className="field">
          <span>SMTP host</span>
          <input
            value={props.draft.email.smtpHost}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                email: {
                  ...current.email,
                  smtpHost: event.target.value,
                },
              }))
            }
          />
        </label>
      </div>

      <div className="field-grid">
        <label className="field">
          <span>IMAP port</span>
          <NumberField
            integer
            min={0}
            value={props.draft.email.imapPort}
            onValueChange={(imapPort) =>
              props.updateDraft((current) => ({
                ...current,
                email: {
                  ...current.email,
                  imapPort,
                },
              }))
            }
          />
        </label>
        <label className="field">
          <span>SMTP port</span>
          <NumberField
            integer
            min={0}
            value={props.draft.email.smtpPort}
            onValueChange={(smtpPort) =>
              props.updateDraft((current) => ({
                ...current,
                email: {
                  ...current.email,
                  smtpPort,
                },
              }))
            }
          />
        </label>
      </div>

      <div className="field-grid">
        <Field orientation="horizontal">
          <Switch
            checked={props.draft.email.imapSecure}
            onCheckedChange={(imapSecure) =>
              props.updateDraft((current) => ({
                ...current,
                email: {
                  ...current.email,
                  imapSecure,
                },
              }))
            }
          />
          <FieldContent>
            <FieldLabel>IMAP secure</FieldLabel>
          </FieldContent>
        </Field>
        <Field orientation="horizontal">
          <Switch
            checked={props.draft.email.smtpSecure}
            onCheckedChange={(smtpSecure) =>
              props.updateDraft((current) => ({
                ...current,
                email: {
                  ...current.email,
                  smtpSecure,
                },
              }))
            }
          />
          <FieldContent>
            <FieldLabel>SMTP secure</FieldLabel>
          </FieldContent>
        </Field>
      </div>

      <ListField
        label="Folders"
        value={props.draft.email.folders}
        rows={3}
        placeholder="INBOX, Support"
        onChange={(folders) =>
          props.updateDraft((current) => ({
            ...current,
            email: {
              ...current.email,
              folders,
            },
          }))
        }
      />

      <ListField
        label="Allowed senders"
        value={props.draft.email.allowFrom}
        rows={3}
        placeholder="name@example.com, *@example.com"
        onChange={(allowFrom) =>
          props.updateDraft((current) => ({
            ...current,
            email: {
              ...current.email,
              allowFrom,
            },
          }))
        }
      />

      <div className="field-grid">
        <label className="field">
          <span>Poll interval ms</span>
          <NumberField
            integer
            min={0}
            value={props.draft.email.pollIntervalMs}
            onValueChange={(pollIntervalMs) =>
              props.updateDraft((current) => ({
                ...current,
                email: {
                  ...current.email,
                  pollIntervalMs,
                },
              }))
            }
          />
        </label>
        <label className="field">
          <span>Text chunk limit</span>
          <NumberField
            integer
            min={0}
            value={props.draft.email.textChunkLimit}
            onValueChange={(textChunkLimit) =>
              props.updateDraft((current) => ({
                ...current,
                email: {
                  ...current.email,
                  textChunkLimit,
                },
              }))
            }
          />
        </label>
      </div>

      <label className="field">
        <span>Media max MB</span>
        <NumberField
          integer
          min={0}
          value={props.draft.email.mediaMaxMb}
          onValueChange={(mediaMaxMb) =>
            props.updateDraft((current) => ({
              ...current,
              email: {
                ...current.email,
                mediaMaxMb,
              },
            }))
          }
        />
      </label>
      <ChannelInstructionsField
        kind="email"
        draft={props.draft}
        updateDraft={props.updateDraft}
      />
    </>
  );
}

function VoiceChannelEditor(props: {
  draft: AdminConfig;
  updateDraft: ConfigUpdater;
  authTokenConfigured: boolean;
  authTokenSource: SecretSource;
  token: string;
  onSecretSaved: () => void;
}) {
  return (
    <>
      <Field orientation="horizontal">
        <Switch
          checked={isVoiceEnabled(props.draft)}
          onCheckedChange={(enabled) =>
            props.updateDraft((current) => ({
              ...current,
              voice: {
                ...current.voice,
                enabled,
              },
            }))
          }
        />
        <FieldContent>
          <FieldLabel>Enabled</FieldLabel>
        </FieldContent>
      </Field>

      <div className="field-grid">
        <label className="field">
          <span>Twilio account SID</span>
          <input
            value={props.draft.voice.twilio.accountSid}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                voice: {
                  ...current.voice,
                  twilio: {
                    ...current.voice.twilio,
                    accountSid: event.target.value,
                  },
                },
              }))
            }
            placeholder="AC..."
          />
        </label>
        <label className="field">
          <span>From number</span>
          <input
            value={props.draft.voice.twilio.fromNumber}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                voice: {
                  ...current.voice,
                  twilio: {
                    ...current.voice.twilio,
                    fromNumber: event.target.value,
                  },
                },
              }))
            }
            placeholder="+14155550123"
          />
        </label>
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
        <label className="field">
          <span>Webhook path</span>
          <input
            value={props.draft.voice.webhookPath}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                voice: {
                  ...current.voice,
                  webhookPath: event.target.value,
                },
              }))
            }
            placeholder="/voice"
          />
        </label>
        <label className="field">
          <span>Max concurrent calls</span>
          <NumberField
            integer
            min={0}
            value={props.draft.voice.maxConcurrentCalls}
            onValueChange={(maxConcurrentCalls) =>
              props.updateDraft((current) => ({
                ...current,
                voice: {
                  ...current.voice,
                  maxConcurrentCalls,
                },
              }))
            }
          />
        </label>
      </div>

      <div className="field-grid">
        <label className="field">
          <span>TTS provider</span>
          <select
            value={props.draft.voice.relay.ttsProvider}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                voice: {
                  ...current.voice,
                  relay: {
                    ...current.voice.relay,
                    ttsProvider: event.target
                      .value as AdminConfig['voice']['relay']['ttsProvider'],
                  },
                },
              }))
            }
          >
            <option value="default">default</option>
            <option value="google">google</option>
            <option value="amazon">amazon</option>
          </select>
        </label>
        <label className="field">
          <span>Voice</span>
          <input
            value={props.draft.voice.relay.voice}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                voice: {
                  ...current.voice,
                  relay: {
                    ...current.voice.relay,
                    voice: event.target.value,
                  },
                },
              }))
            }
            placeholder="en-US-Journey-D"
          />
        </label>
      </div>

      <div className="field-grid">
        <label className="field">
          <span>Transcription provider</span>
          <select
            value={props.draft.voice.relay.transcriptionProvider}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                voice: {
                  ...current.voice,
                  relay: {
                    ...current.voice.relay,
                    transcriptionProvider: event.target
                      .value as AdminConfig['voice']['relay']['transcriptionProvider'],
                  },
                },
              }))
            }
          >
            <option value="default">default</option>
            <option value="deepgram">deepgram</option>
            <option value="google">google</option>
          </select>
        </label>
        <label className="field">
          <span>Language</span>
          <input
            value={props.draft.voice.relay.language}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                voice: {
                  ...current.voice,
                  relay: {
                    ...current.voice.relay,
                    language: event.target.value,
                  },
                },
              }))
            }
            placeholder="en-US"
          />
        </label>
      </div>

      <Field orientation="horizontal">
        <Switch
          checked={props.draft.voice.relay.interruptible}
          onCheckedChange={(interruptible) =>
            props.updateDraft((current) => ({
              ...current,
              voice: {
                ...current.voice,
                relay: {
                  ...current.voice.relay,
                  interruptible,
                },
              },
            }))
          }
        />
        <FieldContent>
          <FieldLabel>Interruptible</FieldLabel>
        </FieldContent>
      </Field>

      <label className="field textarea-field">
        <span>Welcome greeting</span>
        <textarea
          rows={3}
          value={props.draft.voice.relay.welcomeGreeting}
          onChange={(event) =>
            props.updateDraft((current) => ({
              ...current,
              voice: {
                ...current.voice,
                relay: {
                  ...current.voice.relay,
                  welcomeGreeting: event.target.value,
                },
              },
            }))
          }
        />
      </label>
      <ChannelInstructionsField
        kind="voice"
        draft={props.draft}
        updateDraft={props.updateDraft}
      />

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
  updateDraft: ConfigUpdater;
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

      <Field orientation="horizontal">
        <Switch
          checked={props.draft.msteams.enabled}
          onCheckedChange={(enabled) =>
            props.updateDraft((current) => ({
              ...current,
              msteams: {
                ...current.msteams,
                enabled,
              },
            }))
          }
        />
        <FieldContent>
          <FieldLabel>Enabled</FieldLabel>
        </FieldContent>
      </Field>

      <div className="field-grid">
        <label className="field">
          <span>App ID</span>
          <input
            value={props.draft.msteams.appId}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                msteams: {
                  ...current.msteams,
                  appId: event.target.value,
                },
              }))
            }
          />
        </label>
        <label className="field">
          <span>Tenant ID</span>
          <input
            value={props.draft.msteams.tenantId}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                msteams: {
                  ...current.msteams,
                  tenantId: event.target.value,
                },
              }))
            }
          />
        </label>
      </div>

      <div className="field-grid">
        <label className="field">
          <span>Webhook path</span>
          <input
            value={props.draft.msteams.webhook.path}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                msteams: {
                  ...current.msteams,
                  webhook: {
                    ...current.msteams.webhook,
                    path: event.target.value,
                  },
                },
              }))
            }
          />
        </label>
        <label className="field">
          <span>Webhook port</span>
          <NumberField
            integer
            min={0}
            max={65535}
            value={props.draft.msteams.webhook.port}
            onValueChange={(port) =>
              props.updateDraft((current) => ({
                ...current,
                msteams: {
                  ...current.msteams,
                  webhook: {
                    ...current.msteams.webhook,
                    port,
                  },
                },
              }))
            }
          />
        </label>
      </div>

      <div className="field-grid">
        <label className="field">
          <span>DM policy</span>
          <select
            value={props.draft.msteams.dmPolicy}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                msteams: {
                  ...current.msteams,
                  dmPolicy: event.target
                    .value as AdminConfig['msteams']['dmPolicy'],
                },
              }))
            }
          >
            <option value="open">open</option>
            <option value="allowlist">allowlist</option>
            <option value="disabled">disabled</option>
          </select>
        </label>
        <label className="field">
          <span>Group policy</span>
          <select
            value={props.draft.msteams.groupPolicy}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                msteams: {
                  ...current.msteams,
                  groupPolicy: event.target
                    .value as AdminConfig['msteams']['groupPolicy'],
                },
              }))
            }
          >
            <option value="open">open</option>
            <option value="allowlist">allowlist</option>
            <option value="disabled">disabled</option>
          </select>
        </label>
      </div>

      <div className="field-grid">
        <Field orientation="horizontal">
          <Switch
            checked={props.draft.msteams.requireMention}
            onCheckedChange={(requireMention) =>
              props.updateDraft((current) => ({
                ...current,
                msteams: {
                  ...current.msteams,
                  requireMention,
                },
              }))
            }
          />
          <FieldContent>
            <FieldLabel>Require mention</FieldLabel>
          </FieldContent>
        </Field>
        <label className="field">
          <span>Reply style</span>
          <select
            value={props.draft.msteams.replyStyle}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                msteams: {
                  ...current.msteams,
                  replyStyle: event.target
                    .value as AdminConfig['msteams']['replyStyle'],
                },
              }))
            }
          >
            <option value="thread">thread</option>
            <option value="top-level">top-level</option>
          </select>
        </label>
      </div>

      <ListField
        label="Allowed AAD object IDs"
        value={props.draft.msteams.allowFrom}
        rows={4}
        placeholder="comma or newline separated"
        onChange={(allowFrom) =>
          props.updateDraft((current) => ({
            ...current,
            msteams: {
              ...current.msteams,
              allowFrom,
            },
          }))
        }
      />

      <div className="field-grid">
        <label className="field">
          <span>Text chunk limit</span>
          <NumberField
            integer
            min={0}
            value={props.draft.msteams.textChunkLimit}
            onValueChange={(textChunkLimit) =>
              props.updateDraft((current) => ({
                ...current,
                msteams: {
                  ...current.msteams,
                  textChunkLimit,
                },
              }))
            }
          />
        </label>
        <label className="field">
          <span>Media max MB</span>
          <NumberField
            integer
            min={0}
            value={props.draft.msteams.mediaMaxMb}
            onValueChange={(mediaMaxMb) =>
              props.updateDraft((current) => ({
                ...current,
                msteams: {
                  ...current.msteams,
                  mediaMaxMb,
                },
              }))
            }
          />
        </label>
      </div>
      <ChannelInstructionsField
        kind="msteams"
        draft={props.draft}
        updateDraft={props.updateDraft}
      />
    </>
  );
}

function SlackChannelEditor(props: {
  draft: AdminConfig;
  updateDraft: ConfigUpdater;
  botTokenConfigured: boolean;
  botTokenSource: SecretSource;
  appTokenConfigured: boolean;
  appTokenSource: SecretSource;
  token: string;
  onSecretSaved: () => void;
}) {
  return (
    <>
      <Field orientation="horizontal">
        <Switch
          checked={isSlackEnabled(props.draft)}
          onCheckedChange={(enabled) =>
            props.updateDraft((current) => ({
              ...current,
              slack: {
                ...current.slack,
                enabled,
              },
            }))
          }
        />
        <FieldContent>
          <FieldLabel>Enabled</FieldLabel>
        </FieldContent>
      </Field>

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
        <label className="field">
          <span>DM policy</span>
          <select
            value={props.draft.slack.dmPolicy}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                slack: {
                  ...current.slack,
                  dmPolicy: event.target
                    .value as AdminConfig['slack']['dmPolicy'],
                },
              }))
            }
          >
            <option value="open">open</option>
            <option value="allowlist">allowlist</option>
            <option value="disabled">disabled</option>
          </select>
        </label>
        <label className="field">
          <span>Group policy</span>
          <select
            value={props.draft.slack.groupPolicy}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                slack: {
                  ...current.slack,
                  groupPolicy: event.target
                    .value as AdminConfig['slack']['groupPolicy'],
                },
              }))
            }
          >
            <option value="open">open</option>
            <option value="allowlist">allowlist</option>
            <option value="disabled">disabled</option>
          </select>
        </label>
      </div>

      <div className="field-grid">
        <Field orientation="horizontal">
          <Switch
            checked={props.draft.slack.requireMention}
            onCheckedChange={(requireMention) =>
              props.updateDraft((current) => ({
                ...current,
                slack: {
                  ...current.slack,
                  requireMention,
                },
              }))
            }
          />
          <FieldContent>
            <FieldLabel>Require mention</FieldLabel>
          </FieldContent>
        </Field>
        <label className="field">
          <span>Reply style</span>
          <select
            value={props.draft.slack.replyStyle}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                slack: {
                  ...current.slack,
                  replyStyle: event.target
                    .value as AdminConfig['slack']['replyStyle'],
                },
              }))
            }
          >
            <option value="thread">thread</option>
            <option value="top-level">top-level</option>
          </select>
        </label>
      </div>

      <ListField
        label="Allowed DM Slack user IDs"
        value={props.draft.slack.allowFrom}
        rows={4}
        placeholder="comma or newline separated"
        onChange={(allowFrom) =>
          props.updateDraft((current) => ({
            ...current,
            slack: {
              ...current.slack,
              allowFrom,
            },
          }))
        }
      />

      <ListField
        label="Allowed channel Slack user IDs"
        value={props.draft.slack.groupAllowFrom}
        rows={4}
        placeholder="comma or newline separated"
        onChange={(groupAllowFrom) =>
          props.updateDraft((current) => ({
            ...current,
            slack: {
              ...current.slack,
              groupAllowFrom,
            },
          }))
        }
      />

      <div className="field-grid">
        <label className="field">
          <span>Text chunk limit</span>
          <NumberField
            integer
            min={0}
            value={props.draft.slack.textChunkLimit}
            onValueChange={(textChunkLimit) =>
              props.updateDraft((current) => ({
                ...current,
                slack: {
                  ...current.slack,
                  textChunkLimit,
                },
              }))
            }
          />
        </label>
        <label className="field">
          <span>Media max MB</span>
          <NumberField
            integer
            min={0}
            value={props.draft.slack.mediaMaxMb}
            onValueChange={(mediaMaxMb) =>
              props.updateDraft((current) => ({
                ...current,
                slack: {
                  ...current.slack,
                  mediaMaxMb,
                },
              }))
            }
          />
        </label>
      </div>

      <p className="muted-copy">
        Slack runs through Socket Mode. HybridClaw needs both a bot token and an
        app token before the gateway can connect.
      </p>
      <ChannelInstructionsField
        kind="slack"
        draft={props.draft}
        updateDraft={props.updateDraft}
      />
    </>
  );
}

function SlackWebhookChannelEditor(props: {
  draft: AdminConfig;
  onConfigSaved: (config: AdminConfig) => void;
  token: string;
  updateDraft: ConfigUpdater;
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
      <Field orientation="horizontal">
        <Switch
          checked={props.draft.slackWebhook.enabled}
          onCheckedChange={(enabled) =>
            props.updateDraft((current) => ({
              ...current,
              slackWebhook: {
                ...current.slackWebhook,
                enabled,
              },
            }))
          }
        />
        <FieldContent>
          <FieldLabel>Enabled</FieldLabel>
        </FieldContent>
      </Field>

      <div className="field">
        <span>Webhook targets</span>
        <div className="readonly-value">
          {targets.length > 0 ? targets.join(', ') : 'none'}
        </div>
      </div>

      <div className="field-grid">
        <label className="field">
          <span>Target</span>
          <input
            list="slack-webhook-targets"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          />
          <datalist id="slack-webhook-targets">
            {targets.map((entry) => (
              <option key={entry} value={entry} />
            ))}
          </datalist>
        </label>
        <label className="field">
          <span>Webhook URL</span>
          <input
            type="password"
            autoComplete="off"
            placeholder={
              selectedTarget ? 'leave blank to keep current URL' : 'required'
            }
            value={webhookUrl}
            onChange={(event) => setWebhookUrl(event.target.value)}
          />
        </label>
      </div>

      <div className="field-grid">
        <label className="field">
          <span>Username</span>
          <input
            value={defaultUsername}
            onChange={(event) => setDefaultUsername(event.target.value)}
          />
        </label>
        <label className="field">
          <span>Icon emoji</span>
          <input
            value={defaultIconEmoji}
            onChange={(event) => setDefaultIconEmoji(event.target.value)}
          />
        </label>
      </div>

      <label className="field">
        <span>Icon URL</span>
        <input
          value={defaultIconUrl}
          onChange={(event) => setDefaultIconUrl(event.target.value)}
        />
      </label>

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

      <ChannelInstructionsField
        kind="slack_webhook"
        draft={props.draft}
        updateDraft={props.updateDraft}
      />
    </>
  );
}

function DiscordWebhookChannelEditor(props: {
  draft: AdminConfig;
  onConfigSaved: (config: AdminConfig) => void;
  token: string;
  updateDraft: ConfigUpdater;
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
      <Field orientation="horizontal">
        <Switch
          checked={props.draft.discordWebhook.enabled}
          onCheckedChange={(enabled) =>
            props.updateDraft((current) => ({
              ...current,
              discordWebhook: {
                ...current.discordWebhook,
                enabled,
              },
            }))
          }
        />
        <FieldContent>
          <FieldLabel>Enabled</FieldLabel>
        </FieldContent>
      </Field>

      <div className="field">
        <span>Webhook targets</span>
        <div className="readonly-value">
          {targets.length > 0 ? targets.join(', ') : 'none'}
        </div>
      </div>

      <div className="field-grid">
        <label className="field">
          <span>Target</span>
          <input
            list="discord-webhook-targets"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          />
          <datalist id="discord-webhook-targets">
            {targets.map((entry) => (
              <option key={entry} value={entry} />
            ))}
          </datalist>
        </label>
        <label className="field">
          <span>Webhook URL</span>
          <input
            type="password"
            autoComplete="off"
            placeholder={
              selectedTarget ? 'leave blank to keep current URL' : 'required'
            }
            value={webhookUrl}
            onChange={(event) => setWebhookUrl(event.target.value)}
          />
        </label>
      </div>

      <div className="field-grid">
        <label className="field">
          <span>Username</span>
          <input
            value={defaultUsername}
            onChange={(event) => setDefaultUsername(event.target.value)}
          />
        </label>
        <label className="field">
          <span>Avatar URL</span>
          <input
            value={defaultAvatarUrl}
            onChange={(event) => setDefaultAvatarUrl(event.target.value)}
          />
        </label>
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

      <ChannelInstructionsField
        kind="discord_webhook"
        draft={props.draft}
        updateDraft={props.updateDraft}
      />
    </>
  );
}

function IMessageChannelEditor(props: {
  draft: AdminConfig;
  updateDraft: ConfigUpdater;
  passwordConfigured: boolean;
  passwordSource: SecretSource;
  token: string;
  onSecretSaved: () => void;
}) {
  const isRemote = props.draft.imessage.backend === 'bluebubbles';

  return (
    <>
      <Field orientation="horizontal">
        <Switch
          checked={props.draft.imessage.enabled}
          onCheckedChange={(enabled) =>
            props.updateDraft((current) => ({
              ...current,
              imessage: {
                ...current.imessage,
                enabled,
              },
            }))
          }
        />
        <FieldContent>
          <FieldLabel>Enabled</FieldLabel>
        </FieldContent>
      </Field>

      <label className="field">
        <span>Backend</span>
        <select
          value={props.draft.imessage.backend}
          onChange={(event) =>
            props.updateDraft((current) => ({
              ...current,
              imessage: {
                ...current.imessage,
                backend: event.target
                  .value as AdminConfig['imessage']['backend'],
              },
            }))
          }
        >
          <option value="local">local</option>
          <option value="bluebubbles">remote</option>
        </select>
      </label>

      {isRemote ? (
        <>
          <div className="field-grid">
            <label className="field">
              <span>Server URL</span>
              <input
                value={props.draft.imessage.serverUrl}
                onChange={(event) =>
                  props.updateDraft((current) => ({
                    ...current,
                    imessage: {
                      ...current.imessage,
                      serverUrl: event.target.value,
                    },
                  }))
                }
              />
            </label>
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

          <label className="field">
            <span>Webhook path</span>
            <input
              value={props.draft.imessage.webhookPath}
              onChange={(event) =>
                props.updateDraft((current) => ({
                  ...current,
                  imessage: {
                    ...current.imessage,
                    webhookPath: event.target.value,
                  },
                }))
              }
            />
          </label>

          <Field orientation="horizontal">
            <Switch
              checked={props.draft.imessage.allowPrivateNetwork}
              onCheckedChange={(allowPrivateNetwork) =>
                props.updateDraft((current) => ({
                  ...current,
                  imessage: {
                    ...current.imessage,
                    allowPrivateNetwork,
                  },
                }))
              }
            />
            <FieldContent>
              <FieldLabel>Allow private network</FieldLabel>
            </FieldContent>
          </Field>
        </>
      ) : (
        <div className="field-grid">
          <label className="field">
            <span>CLI path</span>
            <input
              value={props.draft.imessage.cliPath}
              onChange={(event) =>
                props.updateDraft((current) => ({
                  ...current,
                  imessage: {
                    ...current.imessage,
                    cliPath: event.target.value,
                  },
                }))
              }
            />
          </label>
          <label className="field">
            <span>Database path</span>
            <input
              value={props.draft.imessage.dbPath}
              onChange={(event) =>
                props.updateDraft((current) => ({
                  ...current,
                  imessage: {
                    ...current.imessage,
                    dbPath: event.target.value,
                  },
                }))
              }
            />
          </label>
        </div>
      )}

      <div className="field-grid">
        <label className="field">
          <span>DM policy</span>
          <select
            value={props.draft.imessage.dmPolicy}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                imessage: {
                  ...current.imessage,
                  dmPolicy: event.target
                    .value as AdminConfig['imessage']['dmPolicy'],
                },
              }))
            }
          >
            <option value="open">open</option>
            <option value="allowlist">allowlist</option>
            <option value="disabled">disabled</option>
          </select>
        </label>
        <label className="field">
          <span>Group policy</span>
          <select
            value={props.draft.imessage.groupPolicy}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                imessage: {
                  ...current.imessage,
                  groupPolicy: event.target
                    .value as AdminConfig['imessage']['groupPolicy'],
                },
              }))
            }
          >
            <option value="open">open</option>
            <option value="allowlist">allowlist</option>
            <option value="disabled">disabled</option>
          </select>
        </label>
      </div>

      <ListField
        label="Allowed DM senders"
        value={props.draft.imessage.allowFrom}
        rows={3}
        placeholder="phone, email, or chat:id"
        onChange={(allowFrom) =>
          props.updateDraft((current) => ({
            ...current,
            imessage: {
              ...current.imessage,
              allowFrom,
            },
          }))
        }
      />

      <ListField
        label="Allowed group senders"
        value={props.draft.imessage.groupAllowFrom}
        rows={3}
        placeholder="phone, email, or chat:id"
        onChange={(groupAllowFrom) =>
          props.updateDraft((current) => ({
            ...current,
            imessage: {
              ...current.imessage,
              groupAllowFrom,
            },
          }))
        }
      />

      <div className="field-grid">
        <label className="field">
          <span>
            {isRemote ? 'Webhook / poll interval ms' : 'Poll interval ms'}
          </span>
          <NumberField
            integer
            min={0}
            value={props.draft.imessage.pollIntervalMs}
            onValueChange={(pollIntervalMs) =>
              props.updateDraft((current) => ({
                ...current,
                imessage: {
                  ...current.imessage,
                  pollIntervalMs,
                },
              }))
            }
          />
        </label>
        <label className="field">
          <span>Debounce ms</span>
          <NumberField
            integer
            min={0}
            value={props.draft.imessage.debounceMs}
            onValueChange={(debounceMs) =>
              props.updateDraft((current) => ({
                ...current,
                imessage: {
                  ...current.imessage,
                  debounceMs,
                },
              }))
            }
          />
        </label>
      </div>

      <div className="field-grid">
        <label className="field">
          <span>Text chunk limit</span>
          <NumberField
            integer
            min={0}
            value={props.draft.imessage.textChunkLimit}
            onValueChange={(textChunkLimit) =>
              props.updateDraft((current) => ({
                ...current,
                imessage: {
                  ...current.imessage,
                  textChunkLimit,
                },
              }))
            }
          />
        </label>
        <label className="field">
          <span>Media max MB</span>
          <NumberField
            integer
            min={0}
            value={props.draft.imessage.mediaMaxMb}
            onValueChange={(mediaMaxMb) =>
              props.updateDraft((current) => ({
                ...current,
                imessage: {
                  ...current.imessage,
                  mediaMaxMb,
                },
              }))
            }
          />
        </label>
      </div>
      <ChannelInstructionsField
        kind="imessage"
        draft={props.draft}
        updateDraft={props.updateDraft}
      />
    </>
  );
}

function renderSelectedEditor(
  kind: ChannelKind,
  draft: AdminConfig,
  updateDraft: ConfigUpdater,
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
          updateDraft={updateDraft}
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
          updateDraft={updateDraft}
          linked={whatsappStatus.linked}
          pairingQrText={whatsappStatus.pairingQrText}
        />
      );
    case 'slack':
      return (
        <SlackChannelEditor
          draft={draft}
          updateDraft={updateDraft}
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
          updateDraft={updateDraft}
        />
      );
    case 'discord_webhook':
      return (
        <DiscordWebhookChannelEditor
          draft={draft}
          onConfigSaved={onConfigSaved}
          token={token}
          updateDraft={updateDraft}
        />
      );
    case 'telegram':
      return (
        <TelegramChannelEditor
          draft={draft}
          updateDraft={updateDraft}
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
          updateDraft={updateDraft}
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
          updateDraft={updateDraft}
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
          updateDraft={updateDraft}
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
          updateDraft={updateDraft}
          passwordConfigured={secretStatus.email.configured}
          passwordSource={secretStatus.email.source}
          hybridaiApiKeyConfigured={hybridaiApiKeyConfigured}
          token={token}
          onSecretSaved={onSecretSaved}
        />
      );
    case 'msteams':
      return <TeamsChannelEditor draft={draft} updateDraft={updateDraft} />;
    case 'imessage':
      return (
        <IMessageChannelEditor
          draft={draft}
          updateDraft={updateDraft}
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
  const [draft, setDraft] = useState<AdminConfig | null>(null);
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

  const saveMutation = useFormMutation({
    mutationFn: (nextConfig: AdminConfig) => saveConfig(auth.token, nextConfig),
    onSuccess: (payload) => {
      queryClient.setQueryData(['config', auth.token], payload);
      setDraft(structuredClone(payload.config));
      toast.success('Channel settings saved.');
    },
    onError: (error) => {
      toast.error('Save failed', error.message);
    },
    invalidates: [['status', auth.token], ['overview']],
  });

  useEffect(() => {
    if (!configQuery.data || draft) return;
    setDraft(structuredClone(configQuery.data.config));
  }, [configQuery.data, draft]);

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

  const updateDraft: ConfigUpdater = (updater) => {
    saveMutation.reset();
    setDraft((current) => (current ? updater(current) : current));
  };

  if (configQuery.isLoading && !draft) {
    return <div className="empty-state">Loading channel settings...</div>;
  }

  if (!draft) {
    return <div className="empty-state">Channel settings are unavailable.</div>;
  }

  const selectedChannel =
    catalog.find((entry) => entry.kind === selectedKind) ?? catalog[0] ?? null;
  const isDirty = configQuery.data
    ? JSON.stringify(draft) !== JSON.stringify(configQuery.data.config)
    : false;
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
                    updateDraft,
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
                      queryClient.setQueryData(['config', auth.token], payload);
                      setDraft(structuredClone(config));
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
                  type="button"
                  loading={saveMutation.isPending}
                  disabled={!isDirty || saveMutation.isPending}
                  onClick={() => saveMutation.mutate(draft)}
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
                    setDraft(structuredClone(configQuery.data.config));
                  }}
                >
                  Reset changes
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
