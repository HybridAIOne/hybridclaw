import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  fetchConfig,
  saveConfig,
  setRuntimeSecret,
  validateToken,
} from '../api/client';
import type { AdminConfig } from '../api/types';
import { useAuth } from '../auth';
import { ChannelLogo } from '../components/channel-logo';
import { useToast } from '../components/toast';
import { BooleanField, Panel } from '../components/ui';
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

function cloneConfig<T>(value: T): T {
  return structuredClone(value);
}

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

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
    | 'TWILIO_AUTH_TOKEN'
    | 'EMAIL_PASSWORD'
    | 'IMESSAGE_PASSWORD';
  secretLabel: 'token' | 'password';
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
          <button
            className="ghost-button"
            type="button"
            onClick={() => {
              saveSecretMutation.reset();
              setIsEditing(true);
              setNextValue('');
            }}
          >
            {actionLabel}
          </button>
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
            <button
              className="primary-button"
              type="button"
              disabled={!nextValue.trim() || saveSecretMutation.isPending}
              onClick={() => saveSecretMutation.mutate(nextValue)}
            >
              {saveSecretMutation.isPending
                ? 'Saving...'
                : `Save ${props.secretLabel}`}
            </button>
            <button
              className="ghost-button"
              type="button"
              disabled={saveSecretMutation.isPending}
              onClick={() => {
                saveSecretMutation.reset();
                setIsEditing(false);
                setNextValue('');
              }}
            >
              Cancel
            </button>
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
      <BooleanField
        label="Enabled"
        value={isDiscordEnabled(props.draft)}
        trueLabel="on"
        falseLabel="off"
        onChange={(enabled) =>
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

      <BooleanField
        label="Commands only"
        value={props.draft.discord.commandsOnly}
        trueLabel="on"
        falseLabel="off"
        onChange={(commandsOnly) =>
          props.updateDraft((current) => ({
            ...current,
            discord: {
              ...current.discord,
              commandsOnly,
            },
          }))
        }
      />

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
          <input
            type="number"
            value={String(props.draft.discord.textChunkLimit)}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                discord: {
                  ...current.discord,
                  textChunkLimit: parseInteger(event.target.value),
                },
              }))
            }
          />
        </label>
      </div>

      <div className="field-grid">
        <label className="field">
          <span>Debounce ms</span>
          <input
            type="number"
            value={String(props.draft.discord.debounceMs)}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                discord: {
                  ...current.discord,
                  debounceMs: parseInteger(event.target.value),
                },
              }))
            }
          />
        </label>
        <label className="field">
          <span>Max lines per message</span>
          <input
            type="number"
            value={String(props.draft.discord.maxLinesPerMessage)}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                discord: {
                  ...current.discord,
                  maxLinesPerMessage: parseInteger(event.target.value),
                },
              }))
            }
          />
        </label>
      </div>

      <div className="field-grid">
        <label className="field">
          <span>Rate limit per user</span>
          <input
            type="number"
            value={String(props.draft.discord.rateLimitPerUser)}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                discord: {
                  ...current.discord,
                  rateLimitPerUser: parseInteger(event.target.value),
                },
              }))
            }
          />
        </label>
        <label className="field">
          <span>Max concurrent per channel</span>
          <input
            type="number"
            value={String(props.draft.discord.maxConcurrentPerChannel)}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                discord: {
                  ...current.discord,
                  maxConcurrentPerChannel: parseInteger(event.target.value),
                },
              }))
            }
          />
        </label>
      </div>

      <BooleanField
        label="Remove ack after reply"
        value={props.draft.discord.removeAckAfterReply}
        trueLabel="on"
        falseLabel="off"
        onChange={(removeAckAfterReply) =>
          props.updateDraft((current) => ({
            ...current,
            discord: {
              ...current.discord,
              removeAckAfterReply,
            },
          }))
        }
      />
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
      <BooleanField
        label="Enabled"
        value={isWhatsAppEnabled(props.draft)}
        trueLabel="on"
        falseLabel="off"
        onChange={(enabled) =>
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
              groupPolicy: enabled ? current.whatsapp.groupPolicy : 'disabled',
            },
          }))
        }
      />

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
          <input
            type="number"
            value={String(props.draft.whatsapp.debounceMs)}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                whatsapp: {
                  ...current.whatsapp,
                  debounceMs: parseInteger(event.target.value),
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
          <input
            type="number"
            value={String(props.draft.whatsapp.textChunkLimit)}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                whatsapp: {
                  ...current.whatsapp,
                  textChunkLimit: parseInteger(event.target.value),
                },
              }))
            }
          />
        </label>
        <label className="field">
          <span>Media max MB</span>
          <input
            type="number"
            value={String(props.draft.whatsapp.mediaMaxMb)}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                whatsapp: {
                  ...current.whatsapp,
                  mediaMaxMb: parseInteger(event.target.value),
                },
              }))
            }
          />
        </label>
      </div>

      <BooleanField
        label="Send read receipts"
        value={props.draft.whatsapp.sendReadReceipts}
        trueLabel="on"
        falseLabel="off"
        onChange={(sendReadReceipts) =>
          props.updateDraft((current) => ({
            ...current,
            whatsapp: {
              ...current.whatsapp,
              sendReadReceipts,
            },
          }))
        }
      />
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
      <BooleanField
        label="Enabled"
        value={props.draft.telegram.enabled}
        trueLabel="on"
        falseLabel="off"
        onChange={(enabled) =>
          props.updateDraft((current) => ({
            ...current,
            telegram: {
              ...current.telegram,
              enabled,
            },
          }))
        }
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
        <label className="field">
          <span>Poll interval ms</span>
          <input
            type="number"
            value={String(props.draft.telegram.pollIntervalMs)}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                telegram: {
                  ...current.telegram,
                  pollIntervalMs: parseInteger(event.target.value),
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

      <BooleanField
        label="Require mention in groups"
        value={props.draft.telegram.requireMention}
        trueLabel="on"
        falseLabel="off"
        onChange={(requireMention) =>
          props.updateDraft((current) => ({
            ...current,
            telegram: {
              ...current.telegram,
              requireMention,
            },
          }))
        }
      />

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
          <input
            type="number"
            value={String(props.draft.telegram.textChunkLimit)}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                telegram: {
                  ...current.telegram,
                  textChunkLimit: parseInteger(event.target.value),
                },
              }))
            }
          />
        </label>
        <label className="field">
          <span>Media max MB</span>
          <input
            type="number"
            value={String(props.draft.telegram.mediaMaxMb)}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                telegram: {
                  ...current.telegram,
                  mediaMaxMb: parseInteger(event.target.value),
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

function EmailChannelEditor(props: {
  draft: AdminConfig;
  updateDraft: ConfigUpdater;
  passwordConfigured: boolean;
  passwordSource: SecretSource;
  token: string;
  onSecretSaved: () => void;
}) {
  return (
    <>
      <BooleanField
        label="Enabled"
        value={props.draft.email.enabled}
        trueLabel="on"
        falseLabel="off"
        onChange={(enabled) =>
          props.updateDraft((current) => ({
            ...current,
            email: {
              ...current.email,
              enabled,
            },
          }))
        }
      />

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
          <input
            type="number"
            value={String(props.draft.email.imapPort)}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                email: {
                  ...current.email,
                  imapPort: parseInteger(event.target.value),
                },
              }))
            }
          />
        </label>
        <label className="field">
          <span>SMTP port</span>
          <input
            type="number"
            value={String(props.draft.email.smtpPort)}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                email: {
                  ...current.email,
                  smtpPort: parseInteger(event.target.value),
                },
              }))
            }
          />
        </label>
      </div>

      <div className="field-grid">
        <BooleanField
          label="IMAP secure"
          value={props.draft.email.imapSecure}
          trueLabel="on"
          falseLabel="off"
          onChange={(imapSecure) =>
            props.updateDraft((current) => ({
              ...current,
              email: {
                ...current.email,
                imapSecure,
              },
            }))
          }
        />
        <BooleanField
          label="SMTP secure"
          value={props.draft.email.smtpSecure}
          trueLabel="on"
          falseLabel="off"
          onChange={(smtpSecure) =>
            props.updateDraft((current) => ({
              ...current,
              email: {
                ...current.email,
                smtpSecure,
              },
            }))
          }
        />
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
          <input
            type="number"
            value={String(props.draft.email.pollIntervalMs)}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                email: {
                  ...current.email,
                  pollIntervalMs: parseInteger(event.target.value),
                },
              }))
            }
          />
        </label>
        <label className="field">
          <span>Text chunk limit</span>
          <input
            type="number"
            value={String(props.draft.email.textChunkLimit)}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                email: {
                  ...current.email,
                  textChunkLimit: parseInteger(event.target.value),
                },
              }))
            }
          />
        </label>
      </div>

      <label className="field">
        <span>Media max MB</span>
        <input
          type="number"
          value={String(props.draft.email.mediaMaxMb)}
          onChange={(event) =>
            props.updateDraft((current) => ({
              ...current,
              email: {
                ...current.email,
                mediaMaxMb: parseInteger(event.target.value),
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
      <BooleanField
        label="Enabled"
        value={isVoiceEnabled(props.draft)}
        trueLabel="on"
        falseLabel="off"
        onChange={(enabled) =>
          props.updateDraft((current) => ({
            ...current,
            voice: {
              ...current.voice,
              enabled,
            },
          }))
        }
      />

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
          <input
            type="number"
            value={String(props.draft.voice.maxConcurrentCalls)}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                voice: {
                  ...current.voice,
                  maxConcurrentCalls: parseInteger(event.target.value),
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

      <BooleanField
        label="Interruptible"
        value={props.draft.voice.relay.interruptible}
        trueLabel="on"
        falseLabel="off"
        onChange={(interruptible) =>
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

      <BooleanField
        label="Enabled"
        value={props.draft.msteams.enabled}
        trueLabel="on"
        falseLabel="off"
        onChange={(enabled) =>
          props.updateDraft((current) => ({
            ...current,
            msteams: {
              ...current.msteams,
              enabled,
            },
          }))
        }
      />

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
          <input
            type="number"
            value={String(props.draft.msteams.webhook.port)}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                msteams: {
                  ...current.msteams,
                  webhook: {
                    ...current.msteams.webhook,
                    port: parseInteger(event.target.value),
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
        <BooleanField
          label="Require mention"
          value={props.draft.msteams.requireMention}
          trueLabel="on"
          falseLabel="off"
          onChange={(requireMention) =>
            props.updateDraft((current) => ({
              ...current,
              msteams: {
                ...current.msteams,
                requireMention,
              },
            }))
          }
        />
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
          <input
            type="number"
            value={String(props.draft.msteams.textChunkLimit)}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                msteams: {
                  ...current.msteams,
                  textChunkLimit: parseInteger(event.target.value),
                },
              }))
            }
          />
        </label>
        <label className="field">
          <span>Media max MB</span>
          <input
            type="number"
            value={String(props.draft.msteams.mediaMaxMb)}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                msteams: {
                  ...current.msteams,
                  mediaMaxMb: parseInteger(event.target.value),
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
      <BooleanField
        label="Enabled"
        value={isSlackEnabled(props.draft)}
        trueLabel="on"
        falseLabel="off"
        onChange={(enabled) =>
          props.updateDraft((current) => ({
            ...current,
            slack: {
              ...current.slack,
              enabled,
            },
          }))
        }
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
        <BooleanField
          label="Require mention"
          value={props.draft.slack.requireMention}
          trueLabel="on"
          falseLabel="off"
          onChange={(requireMention) =>
            props.updateDraft((current) => ({
              ...current,
              slack: {
                ...current.slack,
                requireMention,
              },
            }))
          }
        />
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
          <input
            type="number"
            value={String(props.draft.slack.textChunkLimit)}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                slack: {
                  ...current.slack,
                  textChunkLimit: parseInteger(event.target.value),
                },
              }))
            }
          />
        </label>
        <label className="field">
          <span>Media max MB</span>
          <input
            type="number"
            value={String(props.draft.slack.mediaMaxMb)}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                slack: {
                  ...current.slack,
                  mediaMaxMb: parseInteger(event.target.value),
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
      <BooleanField
        label="Enabled"
        value={props.draft.imessage.enabled}
        trueLabel="on"
        falseLabel="off"
        onChange={(enabled) =>
          props.updateDraft((current) => ({
            ...current,
            imessage: {
              ...current.imessage,
              enabled,
            },
          }))
        }
      />

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

          <BooleanField
            label="Allow private network"
            value={props.draft.imessage.allowPrivateNetwork}
            trueLabel="on"
            falseLabel="off"
            onChange={(allowPrivateNetwork) =>
              props.updateDraft((current) => ({
                ...current,
                imessage: {
                  ...current.imessage,
                  allowPrivateNetwork,
                },
              }))
            }
          />
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
          <input
            type="number"
            value={String(props.draft.imessage.pollIntervalMs)}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                imessage: {
                  ...current.imessage,
                  pollIntervalMs: parseInteger(event.target.value),
                },
              }))
            }
          />
        </label>
        <label className="field">
          <span>Debounce ms</span>
          <input
            type="number"
            value={String(props.draft.imessage.debounceMs)}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                imessage: {
                  ...current.imessage,
                  debounceMs: parseInteger(event.target.value),
                },
              }))
            }
          />
        </label>
      </div>

      <div className="field-grid">
        <label className="field">
          <span>Text chunk limit</span>
          <input
            type="number"
            value={String(props.draft.imessage.textChunkLimit)}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                imessage: {
                  ...current.imessage,
                  textChunkLimit: parseInteger(event.target.value),
                },
              }))
            }
          />
        </label>
        <label className="field">
          <span>Media max MB</span>
          <input
            type="number"
            value={String(props.draft.imessage.mediaMaxMb)}
            onChange={(event) =>
              props.updateDraft((current) => ({
                ...current,
                imessage: {
                  ...current.imessage,
                  mediaMaxMb: parseInteger(event.target.value),
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
  whatsappStatus: {
    linked: boolean;
    pairingQrText: string | null;
  },
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

  const saveMutation = useMutation({
    mutationFn: async (nextConfig: AdminConfig) => {
      return saveConfig(auth.token, nextConfig);
    },
    onSuccess: (payload) => {
      queryClient.setQueryData(['config', auth.token], payload);
      setDraft(cloneConfig(payload.config));
      toast.success('Channel settings saved.');
    },
    onError: (error) => {
      toast.error('Save failed', getErrorMessage(error));
    },
  });

  useEffect(() => {
    if (!configQuery.data || draft) return;
    setDraft(cloneConfig(configQuery.data.config));
  }, [configQuery.data, draft]);

  const catalog = draft
    ? buildChannelCatalog(draft, {
        discordTokenConfigured: statusQuery.data?.discord?.tokenConfigured,
        slackBotTokenConfigured: statusQuery.data?.slack?.botTokenConfigured,
        slackAppTokenConfigured: statusQuery.data?.slack?.appTokenConfigured,
        telegramTokenConfigured: statusQuery.data?.telegram?.tokenConfigured,
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
    if (selectedKind && catalog.some((entry) => entry.kind === selectedKind)) {
      return;
    }
    setSelectedKind(firstCatalogEntry.kind);
  }, [catalog, selectedKind]);

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

  return (
    <div className="page-stack">
      <div className="two-column-grid channels-layout">
        <Panel>
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
        </Panel>

        <Panel
          title={
            selectedChannel ? `${selectedChannel.label} settings` : 'Channels'
          }
          accent="warm"
        >
          <div className="stack-form">
            {selectedChannel
              ? renderSelectedEditor(
                  selectedChannel.kind,
                  draft,
                  updateDraft,
                  auth.token,
                  secretStatus,
                  whatsappStatus,
                  () => {
                    void queryClient.invalidateQueries({
                      queryKey: ['status', auth.token],
                    });
                  },
                )
              : null}

            <div className="button-row">
              <button
                className="primary-button"
                type="button"
                disabled={!isDirty || saveMutation.isPending}
                onClick={() => saveMutation.mutate(draft)}
              >
                {saveMutation.isPending ? 'Saving...' : 'Save channel settings'}
              </button>
              <button
                className="ghost-button"
                type="button"
                disabled={!isDirty || !configQuery.data}
                onClick={() => {
                  if (!configQuery.data) return;
                  saveMutation.reset();
                  setDraft(cloneConfig(configQuery.data.config));
                }}
              >
                Reset changes
              </button>
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}
