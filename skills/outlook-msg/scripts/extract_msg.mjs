#!/usr/bin/env node

import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

// Shared skill libraries resolve through NODE_PATH, which import() ignores.
const MsgReader = createRequire(import.meta.url)('@kenjiuno/msgreader').default;

const MAX_FILENAME_CHARS = 120;
const HTML_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function parseArgs(argv) {
  const args = { inputPath: '', outDir: '', json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value) continue;
    if (value === '--json') {
      args.json = true;
      continue;
    }
    if (value === '--out') {
      args.outDir = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (!args.inputPath) {
      args.inputPath = value;
    }
  }
  return args;
}

function formatAddress(name, address) {
  const cleanName = (name || '').trim();
  const cleanAddress = (address || '').trim();
  if (!cleanAddress) return cleanName;
  if (!cleanName || cleanName === cleanAddress) return cleanAddress;
  return `${cleanName} <${cleanAddress}>`;
}

function decodeHtmlBytes(bytes, codepage) {
  if (codepage && codepage !== 65001) {
    try {
      return new TextDecoder(`windows-${codepage}`).decode(bytes);
    } catch {}
  }
  return new TextDecoder('utf-8').decode(bytes);
}

function htmlToText(html) {
  return html
    .replace(/<(head|style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code) => {
      if (code[0] !== '#') return HTML_ENTITIES[code.toLowerCase()] ?? entity;
      const point =
        code[1] === 'x' || code[1] === 'X'
          ? Number.parseInt(code.slice(2), 16)
          : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(point) && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : entity;
    })
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function messageBody(fields) {
  if (fields.body?.trim()) return fields.body.trim();
  if (fields.bodyHtml) return htmlToText(fields.bodyHtml);
  if (fields.html) {
    return htmlToText(decodeHtmlBytes(fields.html, fields.internetCodepage));
  }
  return '';
}

// Attachment names come from the sender: keep only a plain basename.
function safeName(rawName, fallback) {
  const cleaned = path.posix
    .basename(
      String(rawName || '')
        .normalize('NFKC')
        .replace(/\\/g, '/'),
    )
    .replace(/[\p{Cc}<>:"|?*]/gu, '_')
    .replace(/^[\s.]+|[\s.]+$/g, '');
  const name = cleaned || fallback;
  if (name.length <= MAX_FILENAME_CHARS) return name;
  const ext = path.extname(name).slice(0, 20);
  return name.slice(0, MAX_FILENAME_CHARS - ext.length) + ext;
}

function uniqueName(name, used) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let counter = 2; used.has(candidate.toLowerCase()); counter += 1) {
    candidate = `${base} (${counter})${ext}`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

async function extractMessage(reader, fields, outDir) {
  await fs.mkdir(outDir, { recursive: true });
  const recipients = { to: [], cc: [], bcc: [] };
  for (const recipient of fields.recipients || []) {
    const address = formatAddress(
      recipient.name,
      recipient.smtpAddress || recipient.email,
    );
    if (!address) continue;
    (recipients[recipient.recipType] ?? recipients.to).push(address);
  }

  const used = new Set();
  const attachments = [];
  const messages = [];
  for (const [index, attachment] of (fields.attachments || []).entries()) {
    if (attachment.innerMsgContent && attachment.innerMsgContentFields) {
      const inner = attachment.innerMsgContentFields;
      const folder = uniqueName(
        safeName(attachment.name || inner.subject, `message-${index + 1}`),
        used,
      );
      messages.push(
        await extractMessage(reader, inner, path.join(outDir, folder)),
      );
      continue;
    }
    const fileName = uniqueName(
      safeName(
        attachment.fileName || attachment.fileNameShort || attachment.name,
        `attachment-${index + 1}${attachment.extension || ''}`,
      ),
      used,
    );
    const contentType = attachment.attachMimeTag || null;
    // Linked (by-reference) attachments carry no data stream.
    if (typeof attachment.dataId !== 'number') {
      attachments.push({ name: fileName, path: null, size: 0, contentType });
      continue;
    }
    const { content } = reader.getAttachment(attachment);
    const filePath = path.join(outDir, fileName);
    await fs.writeFile(filePath, content);
    attachments.push({
      name: fileName,
      path: filePath,
      size: content.length,
      contentType,
    });
  }

  return {
    from: formatAddress(
      fields.senderName,
      fields.senderSmtpAddress || fields.senderEmail,
    ),
    to: recipients.to,
    cc: recipients.cc,
    bcc: recipients.bcc,
    date:
      fields.messageDeliveryTime ||
      fields.clientSubmitTime ||
      fields.creationTime ||
      null,
    subject: fields.subject || '',
    body: messageBody(fields),
    folder: outDir,
    attachments,
    messages,
  };
}

function printMessage(message, label) {
  console.log(`=== ${label} ===`);
  console.log(`From: ${message.from}`);
  console.log(`To: ${message.to.join(', ')}`);
  if (message.cc.length > 0) console.log(`Cc: ${message.cc.join(', ')}`);
  if (message.bcc.length > 0) console.log(`Bcc: ${message.bcc.join(', ')}`);
  console.log(`Date: ${message.date || ''}`);
  console.log(`Subject: ${message.subject}`);
  console.log('');
  console.log(message.body || '[no body text]');
  if (message.attachments.length > 0 || message.messages.length > 0) {
    console.log('');
    console.log('Attachments:');
    for (const attachment of message.attachments) {
      const type = attachment.contentType ? `, ${attachment.contentType}` : '';
      console.log(
        attachment.path
          ? `- ${attachment.path} (${attachment.size} bytes${type})`
          : `- ${attachment.name} (linked, not stored in the message)`,
      );
    }
    for (const inner of message.messages) {
      console.log(`- ${inner.folder}${path.sep} (embedded message)`);
    }
  }
  for (const inner of message.messages) {
    console.log('');
    printMessage(inner, `Embedded message: ${inner.folder}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.inputPath || !args.outDir) {
    console.error(
      'Usage: node skills/outlook-msg/scripts/extract_msg.mjs <file.msg> --out <dir> [--json]',
    );
    process.exitCode = 1;
    return;
  }

  const buffer = await fs.readFile(args.inputPath);
  const reader = new MsgReader(
    new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength),
  );
  const fields = reader.getFileData();
  if (fields.error) {
    throw new Error(`${args.inputPath}: ${fields.error}`);
  }

  const message = await extractMessage(reader, fields, args.outDir);
  if (args.json) {
    console.log(JSON.stringify(message, null, 2));
    return;
  }
  printMessage(message, args.inputPath);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
