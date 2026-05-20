---
name: distil-pii-redactor
description: Redact, anonymize, sanitize, or remove PII locally with Distil-PII and llama.cpp; keep personal data and secret values out of model context, logs, and chat.
user-invocable: true
requires:
  bins:
    - python3
    - bash
    - curl
    - llama-server
metadata:
  hybridclaw:
    category: security
    short_description: "Local Distil-PII redaction."
    tags:
      - pii
      - redaction
      - privacy
      - local-model
      - security
    install:
      - id: llama-server
        kind: brew
        formula: llama.cpp
        bins: ["llama-server"]
        label: Install llama.cpp server (brew)
    capabilities:
      - pii.redact.local
      - pii.sanitize.text
---

# Distil PII Redactor

Use this skill when the user asks to redact, anonymize, sanitize, or remove PII
or personal data from text. It runs a local Distil-PII GGUF model through
`llama-server`; raw text must not be sent to external APIs.

## Privacy Rules

- Do not quote, summarize, or repeat raw PII in chat.
- Prefer file-based input and output when the sensitive text is already in a
  file or attachment.
- Return only the redacted text unless the user is explicitly debugging the
  redactor itself.
- Do not use `--show-entities` in normal workflows. It emits original values.
- Do not store raw PII in tracked files, shell history, long-lived notes, or
  logs.
- This skill declares no external credentials. If a downstream tool needs
  authentication, use that tool's HybridClaw `secret_ref` or gateway secret
  injection and pass only redacted text downstream.
- Do not convert raw PII into HybridClaw secrets. Secret refs are for
  credentials and auth material, not a transport for user data.

## Setup

If `llama-server` is missing, install it with:

```bash
hybridclaw skill install distil-pii-redactor llama-server
```

or install `llama.cpp` manually. This skill intentionally has no
`credentials:` frontmatter because local inference does not need API keys; any
future remote-provider variant must declare `secret_ref` credentials instead of
reading raw environment variables.

Start the local server:

```bash
bash skills/distil-pii-redactor/scripts/setup.sh
```

The setup script stores the model under `~/.hybridclaw/distil-pii` by default,
downloads the public Distil-PII 1B GGUF model if missing, and starts
`llama-server` on `127.0.0.1:8712`.

Stop the server:

```bash
bash skills/distil-pii-redactor/scripts/stop.sh
```

## Redaction Workflow

For files, keep raw input and redacted output on disk:

```bash
python3 skills/distil-pii-redactor/scripts/redact.py \
  --input-file sensitive.txt \
  --output-file redacted.txt
```

For stdin:

```bash
python3 skills/distil-pii-redactor/scripts/redact.py < sensitive.txt
```

For short text that is already in the conversation, pass it directly only when
there is no lower-exposure path:

```bash
python3 skills/distil-pii-redactor/scripts/redact.py "text to redact"
```

The default output is only `redacted_text`, with sensitive spans replaced by
tokens such as `[PERSON]`, `[EMAIL]`, `[PHONE]`, `[ADDRESS]`, `[SSN]`,
`[CARD_LAST4:1234]`, and `[IBAN_LAST4:1234]`.

## Debug Output

Use `--show-entities` only while testing the redactor, because it includes the
original sensitive values:

```bash
python3 skills/distil-pii-redactor/scripts/redact.py --show-entities \
  --input-file fixture.txt
```

Do not paste debug JSON back to the user unless they explicitly requested it
and understand that it contains original PII.

## Validation

Run:

```bash
python3 skills/skill-creator/scripts/quick_validate.py skills/distil-pii-redactor
python3 skills/distil-pii-redactor/scripts/redact.py --help
bash -n skills/distil-pii-redactor/scripts/setup.sh
bash -n skills/distil-pii-redactor/scripts/stop.sh
```
