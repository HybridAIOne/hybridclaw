---
name: himalaya
description: Manage email with the Himalaya CLI: configure accounts, list folders, read or search messages, draft replies, send mail, or download attachments from the terminal.
user-invocable: true
metadata:
  hybridclaw:
    short_description: Terminal email workflows.
    category: communication
    tags:
      - email
      - imap
      - smtp
      - coworkers
    related_skills:
      - channel-catchup
      - google-workspace
    install:
      - id: brew
        kind: brew
        formula: himalaya
        bins: ["himalaya"]
        label: Install Himalaya (brew)
---

# Himalaya Email CLI

Use Himalaya for host-side IMAP and SMTP email workflows when a terminal-native client is the right tool.

## Default Workflow

1. Verify the CLI:
   ```bash
   himalaya --version
   ```
2. If it is missing, tell the user to run:
   ```bash
   hybridclaw skill install himalaya brew
   ```
3. Verify accounts:
   ```bash
   himalaya account list
   ```
4. If no account exists, run:
   ```bash
   himalaya account configure
   ```
5. If multiple accounts exist, use `--account <name>` explicitly.

## Common Operations

List folders:

```bash
himalaya folder list
```

List message envelopes:

```bash
himalaya envelope list --output json
```

Read a message:

```bash
himalaya message read 42
```

Reply:

```bash
himalaya message reply 42
```

Write and send from a template:

```bash
cat <<'EOF' | himalaya template send
From: you@example.com
To: recipient@example.com
Subject: Follow-up

Draft body here.
EOF
```

Download attachments:

```bash
himalaya attachment download 42 --dir /tmp/himalaya-attachments
```

## Rules

- Draft first, send second. Show the planned email body before sending.
- Confirm before send, delete, move, or forward operations.
- Prefer `--output json` when you need machine-readable search or list results.
- If the user only wants a summary of already ingested email threads, prefer `channel-catchup`.
- Keep account selection explicit when there is any ambiguity.
