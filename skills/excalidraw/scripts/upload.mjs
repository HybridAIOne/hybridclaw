#!/usr/bin/env node

import { createCipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { deflateSync } from 'node:zlib';

const UPLOAD_URL = 'https://json.excalidraw.com/api/v2/post/';
const UPLOAD_TIMEOUT_MS = 30_000;

function concatBuffers(...buffers) {
  const parts = [];
  const version = Buffer.alloc(4);
  version.writeUInt32BE(1, 0);
  parts.push(version);

  for (const buffer of buffers) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(buffer.length, 0);
    parts.push(length, buffer);
  }

  return Buffer.concat(parts);
}

function validateDocument(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('File must contain a JSON object.');
  }

  if (!Array.isArray(document.elements)) {
    throw new Error('File must contain an "elements" array.');
  }
}

async function uploadExcalidrawJson(excalidrawJson) {
  const fileMetadata = Buffer.from(JSON.stringify({}), 'utf8');
  const dataBytes = Buffer.from(excalidrawJson, 'utf8');
  const innerPayload = concatBuffers(fileMetadata, dataBytes);
  const compressed = deflateSync(innerPayload);

  const key = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-128-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(compressed),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  const encodingMetadata = Buffer.from(
    JSON.stringify({
      version: 2,
      compression: 'pako@1',
      encryption: 'AES-GCM',
    }),
    'utf8',
  );
  const payload = concatBuffers(encodingMetadata, iv, ciphertext);

  let response;
  try {
    response = await fetch(UPLOAD_URL, {
      method: 'POST',
      body: payload,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/octet-stream',
      },
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error(
        `Upload timed out after ${Math.round(UPLOAD_TIMEOUT_MS / 1000)}s`,
      );
    }
    throw error;
  }

  if (!response.ok) {
    throw new Error(`Upload failed with HTTP ${response.status}`);
  }

  const result = await response.json();
  if (!result?.id) {
    throw new Error(`Upload returned no file id: ${JSON.stringify(result)}`);
  }

  return `https://excalidraw.com/#json=${result.id},${key.toString('base64url')}`;
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    throw new Error(
      'Usage: node skills/excalidraw/scripts/upload.mjs <path-to-file.excalidraw>',
    );
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const document = JSON.parse(content);
  validateDocument(document);

  const url = await uploadExcalidrawJson(content);
  process.stdout.write(`${url}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
});
