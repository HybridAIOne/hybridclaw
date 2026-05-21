---
title: Fax
description: Wire fax-to-email inbound PDFs and use the fax-send skill for guarded outbound PDF fax delivery.
sidebar_position: 6.5
---

# Fax

HybridClaw treats fax as a document workflow. Inbound fax is configured as
fax-to-email and uses the existing email channel. Outbound fax uses the bundled
`fax-send` skill to create guarded provider requests for PDF delivery.

## Inbound Fax-To-Email

Most hosted fax services can forward received faxes as PDF attachments to an
email mailbox. Configure the provider or telco portal to send inbound fax PDFs
to a dedicated mailbox, then configure HybridClaw email polling for that
mailbox:

```bash
hybridclaw channels email setup \
  --address fax-inbox@example.com \
  --password <mail-password> \
  --imap-host imap.example.com \
  --imap-port 993 \
  --imap-secure \
  --folder INBOX \
  --allow-from fax-provider@example.com
```

Keep a narrow allowlist when the provider has stable sender addresses or
domains. If the provider sends from variable addresses, isolate the mailbox so
only fax traffic lands there.

Reference routing policy:

```yaml
faxInbound:
  channel: email
  mailbox: fax-inbox@example.com
  attachment:
    requiredMimeTypes:
      - application/pdf
    maxSizeMb: 20
  routes:
    - match:
        fromNameContains: "Steuerberater"
      actions:
        - skill: download-platform-invoices
          adapter: datev-unternehmen-online
          category: Eingangsrechnung
        - store:
            path: clients/{{client_id}}/fax/{{date}}-{{message_id}}.pdf
    - match:
        subjectContains: "Notar"
      actions:
        - store:
            path: legal/{{client_id}}/fax/{{date}}-{{message_id}}.pdf
```

The YAML is a reference operator recipe, not a core config schema. Use it to
document the mailbox routing contract for agents and downstream skills such as
DATEV Belegtransfer.

## Outbound Fax

Use `fax-send` for outbound delivery:

```bash
node skills/fax-send/fax_send.cjs --format json http-request send \
  --provider sinch \
  --auth basic \
  --content-url https://example.com/signed-contract.pdf \
  --to +49891234567 \
  --page-count 3 \
  --label costCenter=legal \
  --operator-grant
```

For short text-only test faxes, use direct multipart upload instead of hosting a
PDF:

```bash
node skills/fax-send/fax_send.cjs --format json http-request send \
  --provider sinch \
  --auth basic \
  --text "Hallo Welt" \
  --filename hallo-welt.txt \
  --to +498920931098 \
  --page-count 1 \
  --operator-grant
```

Pass only the emitted `httpRequest` object to `http_request`. The gateway
injects provider credentials from encrypted secrets.

## Provider Setup

For Sinch Fax API:

1. Create or select a Sinch Fax project and fax service for the target region. For German customer testing, use a Sinch EU-region project/service when available on the account.
2. Register or port the sending fax number in the provider dashboard.
3. Store Basic auth as a base64-encoded `username:password` secret:

   ```bash
   hybridclaw secret set SINCH_FAX_BASIC_AUTH "<base64-username-password>"
   ```

4. Store the Sinch account defaults once:

   ```bash
   hybridclaw secret set SINCH_FAX_PROJECT_ID "<sinch-project-id>"
   hybridclaw secret set SINCH_FAX_SERVICE_ID "<sinch-service-id>"
   hybridclaw secret set SINCH_FAX_SENDER_NUMBER "+493012345678"
   ```

5. Use `fax-send` with the approved recipient number. The helper emits
   `<secret:...>` placeholders for the stored project, service, and sender
   values; the gateway resolves them server-side.
6. Configure provider completion callbacks or poll status with:

   ```bash
   node skills/fax-send/fax_send.cjs --format json http-request status \
     --fax-id <provider-fax-id>
   ```

Sinch documents a test outbound recipient number, `+19898989898`, for emulated
fax sends. Use that for provider-side smoke tests before sending to a German
number.

Current provider reference support:

| Provider | Residency note | Status |
| --- | --- | --- |
| Sinch Fax | Use an EU-region project/service for DACH pilots | Implemented |
| Phaxio | Account/provider-region dependent | Reference only |
| Telekom Cloud Fax | German operator path | Reference only |
| Vodafone Mail2Fax | German operator path | Reference only |

## Audit And Retention

Fax delivery should preserve:

- original outbound PDF
- recipient and sender fax numbers
- provider fax ID
- provider delivery status and timestamp
- delivery receipt or completion webhook payload
- failure reason when delivery fails

The skill emits audit intent for `fax.send.start`, `fax.send.delivered`, and
`fax.send.failed`. Runtime integrations persist those rows through
`src/fax/accounting.ts`, including provider message IDs.

Retention expectations for German legal, healthcare, tax, and public
administration workflows:

- archive the outbound PDF or inbound fax PDF unchanged
- archive provider delivery receipts and webhook/status payloads
- keep sender/recipient numbers, provider fax ID, timestamps, page count, and failure reason
- preserve the mailbox message ID for fax-to-email inbound workflows
- align retention and deletion schedules with the customer contract and the relevant legal/tax record class

Signature semantics:

- a fax transmission receipt is operational delivery evidence
- a fax receipt is not proof that the underlying PDF has a qualified electronic signature
- if a workflow depends on a signed original, archive the signed source document separately from the fax transport receipt

Usage accounting records page-based cost through `UsageTotals.billable_units`
with unit `fax-page`.
