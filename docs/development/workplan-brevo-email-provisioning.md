# Auto-Email pro Agent-Instanz via Brevo

## Context

HybridClaw-Instanzen (lokal oder Docker-Cloud) sollen automatisch eine eigene
Email-Adresse bekommen. Adress-Schema: Default `{agentId}@agent.hybridai.one`,
optional frei wählbar.

**Ansatz:** Brevo-Plugin, das das bestehende Plugin Inbound Webhook System nutzt.
Kein Core-Code wird geändert — die gesamte Brevo-Logik lebt als installierbares
Plugin unter `~/.hybridclaw/plugins/brevo-email/`.

### Warum Plugin statt Core-Änderung?

Das Plugin Inbound Webhook Framework (`src/plugins/`) bietet bereits:

- **Webhook-Registrierung** via `registerInboundWebhook()` — automatisch unter
  `/api/plugin-webhooks/{pluginId}/{webhookName}` erreichbar
- **Message-Dispatch** via `dispatchInboundMessage()` — leitet Nachrichten
  direkt in den Agent-Loop (Session, Channel, User-ID, Media)
- **Credential-Management** via `getCredential()` — Env-Vars sicher abfragen
- **Lifecycle** via `registerService()` — Start/Stop für SMTP-Transport
- **Logging** via `context.logger` — strukturiertes Logging pro Plugin
- **Gateway-Routing** — HTTP-Server leitet `/api/plugin-webhooks/*` automatisch

Damit entfällt jede Änderung an Gateway, Config-System oder Email-Channel.

---

## 1. Plugin-Struktur

```
~/.hybridclaw/plugins/brevo-email/
├── package.json
├── index.ts          # Plugin Entry Point
├── brevo-address.ts  # Adress-Auflösung + Reverse-Lookup
├── brevo-inbound.ts  # Webhook-Payload-Parsing
├── brevo-outbound.ts # SMTP-Versand via Brevo Relay
└── types.ts          # Brevo-spezifische Typen
```

### Plugin-Config in `config.json`

```jsonc
{
  "plugins": {
    "brevo-email": {
      "enabled": true,
      "config": {
        "domain": "agent.hybridai.one",
        "smtpHost": "smtp-relay.brevo.com",
        "smtpPort": 587,
        "webhookSecret": ""          // optional, zur Webhook-Validierung
      }
    }
  }
}
```

### Env-Vars (via `getCredential()`)

| Variable | Zweck |
|----------|-------|
| `BREVO_SMTP_LOGIN` | SMTP-Relay Login (Brevo Account-Email) |
| `BREVO_SMTP_KEY` | SMTP-Relay Master-Passwort |
| `BREVO_WEBHOOK_SECRET` | Shared Secret für Webhook-Authentifizierung |

---

## 2. Plugin Entry Point (`index.ts`)

```typescript
import type { HybridClawPluginApi } from 'hybridclaw/plugin-sdk';

export default function register(api: HybridClawPluginApi) {
  const domain = api.pluginConfig.domain as string;
  const smtpLogin = api.getCredential('BREVO_SMTP_LOGIN');
  const smtpKey = api.getCredential('BREVO_SMTP_KEY');
  const webhookSecret = api.getCredential('BREVO_WEBHOOK_SECRET');

  // 1. Inbound Webhook registrieren
  api.registerInboundWebhook({
    name: 'inbound',
    method: 'POST',
    handler: async (ctx) => {
      // → POST /api/plugin-webhooks/brevo-email/inbound
      await handleBrevoInbound(ctx, api, { domain, webhookSecret });
    },
  });

  // 2. SMTP-Transport als Service registrieren (Lifecycle)
  const smtpService = createBrevoSmtpService({ smtpLogin, smtpKey, ...config });
  api.registerService(smtpService);

  // 3. Outbound-Tool registrieren (Agent kann Emails senden)
  api.registerTool({
    name: 'send_email',
    description: 'Send an email from this agent\'s address',
    parameters: { to: 'string', subject: 'string', body: 'string' },
    handler: async (args, ctx) => {
      const fromAddress = resolveAgentEmailAddress(ctx.agentId, domain);
      await smtpService.send({ from: fromAddress, ...args });
    },
  });
}
```

---

## 3. Adress-Auflösung (`brevo-address.ts`)

```typescript
// Default: {agentId}@{domain}
export function resolveAgentEmailAddress(
  agentId: string,
  domain: string,
  override?: string | null,
): string {
  if (override?.trim()) return override.trim();
  return `${agentId}@${domain}`;
}

// Reverse: To-Adresse → Agent-ID
export function resolveAgentIdFromRecipient(
  toAddress: string,
  domain: string,
): string | null {
  const normalized = toAddress.trim().toLowerCase();
  const atIndex = normalized.lastIndexOf('@');
  if (atIndex === -1) return null;
  const localPart = normalized.slice(0, atIndex);
  const emailDomain = normalized.slice(atIndex + 1);
  if (emailDomain !== domain.toLowerCase()) return null;
  return localPart || null;
}
```

---

## 4. Inbound Webhook Handler (`brevo-inbound.ts`)

Brevo Inbound Parsing postet JSON mit folgendem Schema:

```jsonc
{
  "items": [{
    "Uuid": ["..."],
    "MessageId": "<...@brevo.com>",
    "InReplyTo": "<...>",
    "From": { "Address": "sender@example.com", "Name": "Sender" },
    "To": [{ "Address": "marketing@agent.hybridai.one" }],
    "Subject": "Hello",
    "RawTextBody": "...",
    "RawHtmlBody": "...",
    "Attachments": [{ "Name": "file.pdf", "ContentType": "...", "DownloadToken": "..." }]
  }]
}
```

### Handler-Logik

1. **Webhook-Secret prüfen** (Header oder Query-Param vs. Config)
2. **JSON Body lesen** (aus `ctx.req`, gleich wie andere Plugin-Webhooks)
3. **Für jedes Item in `items[]`**:
   a. To-Adresse → `resolveAgentIdFromRecipient()` → Agent-ID
   b. Falls Agent unbekannt → `404` loggen, skip
   c. SessionId bauen: `agent:{agentId}:channel:email:chat:dm:peer:{senderAddress}`
   d. Attachments herunterladen (Brevo Download-Token → temp file)
   e. `api.dispatchInboundMessage()` aufrufen:
      ```typescript
      await api.dispatchInboundMessage({
        sessionId,
        channelId: senderAddress,
        userId: senderAddress,
        username: from.Name || null,
        content: textBody,
        media: attachments,
        agentId,
      });
      ```
4. **200 OK** an Brevo zurückgeben

### Dedup

Brevo liefert `MessageId` mit. Ein einfaches LRU-Set (z.B. 1000 Einträge) im
Plugin-Speicher reicht, um Webhook-Retries zu deduplizieren.

---

## 5. Outbound / SMTP-Service (`brevo-outbound.ts`)

- Nodemailer-Transport mit `smtp-relay.brevo.com:587`
- Auth via `BREVO_SMTP_LOGIN` + `BREVO_SMTP_KEY`
- From-Adresse: `resolveAgentEmailAddress(agentId, domain)`
- Brevo erlaubt beliebige From-Adressen auf verifizierten Domains
- Als `registerService()` registriert → sauberer Start/Stop Lifecycle

---

## 6. DNS/Domain Setup (einmalig, operativ)

| Record | Typ | Wert | Zweck |
|--------|-----|------|-------|
| `agent.hybridai.one` | MX | Brevo Inbound-Server | Emails empfangen |
| `agent.hybridai.one` | TXT | `v=spf1 include:sendinblue.com ~all` | SPF |
| `mail._domainkey.agent.hybridai.one` | TXT | Brevo DKIM-Key | DKIM |
| `_dmarc.agent.hybridai.one` | TXT | `v=DMARC1; p=quarantine` | DMARC |

Brevo Dashboard:
1. Domain `agent.hybridai.one` als Sender verifizieren
2. Inbound Parsing aktivieren
3. Webhook-URL setzen: `https://{gateway-host}/api/plugin-webhooks/brevo-email/inbound`

---

## 7. Auto-Provisioning

Kein Brevo-API-Call bei Agent-Erstellung nötig:

- Domain einmal verifiziert → alle `*@agent.hybridai.one` werden an Webhook
  weitergeleitet
- SMTP-Relay erlaubt Versand von jeder Adresse der Domain
- "Provisioning" = Agent-ID existiert → Email-Adresse funktioniert automatisch

Optionaler Custom-Override: Agent kann in seiner Config ein `emailAddress`-Feld
setzen (z.B. in `IDENTITY.md` oder Agent-Registry), das
`resolveAgentEmailAddress()` bevorzugt.

---

## Datei-Änderungen

| Datei | Typ | Beschreibung |
|-------|-----|--------------|
| `plugins/brevo-email/package.json` | **New** | Plugin-Manifest |
| `plugins/brevo-email/index.ts` | **New** | Entry Point: Webhook + Service + Tool |
| `plugins/brevo-email/brevo-address.ts` | **New** | Adress-Auflösung + Reverse-Lookup |
| `plugins/brevo-email/brevo-inbound.ts` | **New** | Webhook-Payload-Parsing + Dispatch |
| `plugins/brevo-email/brevo-outbound.ts` | **New** | SMTP-Service via Brevo Relay |
| `plugins/brevo-email/types.ts` | **New** | Brevo-Payload-Typen |

**Keine Änderungen am Core-Code** (`src/`, `config.example.json`, Gateway etc.)

---

## Reihenfolge

1. Plugin-Scaffold (package.json, types.ts)
2. Address-Utilities (brevo-address.ts)
3. Inbound-Handler (brevo-inbound.ts) + Webhook-Registrierung
4. Outbound-Service (brevo-outbound.ts) + Tool-Registrierung
5. Entry Point verdrahten (index.ts)
6. Tests (Unit + manueller curl-Test gegen Webhook)
7. DNS-Setup + Brevo-Dashboard-Konfiguration

---

## Verifizierung

- [ ] Unit-Tests für `resolveAgentEmailAddress` und `resolveAgentIdFromRecipient`
- [ ] Brevo Webhook mit Test-Payload simulieren:
      `curl -X POST http://localhost:9090/api/plugin-webhooks/brevo-email/inbound -d @test-payload.json`
- [ ] E2E: Email an `test-agent@agent.hybridai.one` senden → Agent erhält Message
- [ ] E2E: Agent nutzt `send_email` Tool → Email kommt beim Empfänger an
- [ ] Plugin enable/disable → Gateway bleibt stabil
- [ ] Bestehender IMAP-Email-Channel unberührt (Regression)
