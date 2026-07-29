/**
 * Webchat dictation boundary — transcribes one short-lived browser recording.
 *
 * Audio exists only in an OS temporary directory and is removed after the
 * configured transcription chain settles; unlike media uploads, it is never
 * added to the managed cache or conversation history.
 *
 * NOT the inbound-media prelude (`media/audio-transcription.ts`); that path
 * transcribes already-retained message attachments during an agent turn.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { getRuntimeConfig } from '../config/runtime-config.js';
import { GatewayRequestError } from '../errors/gateway-request-error.js';
import {
  resolveAudioTranscriptionModels,
  transcribeAudioWithFallback,
} from '../media/audio-transcription-backends.js';
import { normalizeMimeType } from '../media/mime-utils.js';

const DICTATION_EXTENSION_BY_MIME_TYPE: Readonly<Record<string, string>> = {
  'audio/aac': '.aac',
  'audio/mp4': '.m4a',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'audio/opus': '.opus',
  'audio/wav': '.wav',
  'audio/webm': '.webm',
  'video/mp4': '.m4a',
};

export function isSupportedDictationMimeType(
  value: string | null | undefined,
): boolean {
  const mimeType = normalizeMimeType(value);
  return mimeType ? mimeType in DICTATION_EXTENSION_BY_MIME_TYPE : false;
}

export async function transcribeWebchatDictation(params: {
  audio: Buffer;
  mimeType: string;
  abortSignal?: AbortSignal;
}): Promise<string> {
  const mimeType = normalizeMimeType(params.mimeType);
  if (!mimeType || !isSupportedDictationMimeType(mimeType)) {
    throw new GatewayRequestError(415, 'Unsupported dictation audio format.');
  }
  if (params.audio.length === 0) {
    throw new GatewayRequestError(400, 'Dictation recording is empty.');
  }

  const config = getRuntimeConfig().media.audio;
  if (!config.enabled) {
    throw new GatewayRequestError(
      503,
      'Audio transcription is disabled in the runtime configuration.',
    );
  }

  const models = await resolveAudioTranscriptionModels(config);
  if (models.length === 0) {
    throw new GatewayRequestError(
      503,
      'No audio transcription backend is available.',
    );
  }

  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'hybridclaw-dictation-'),
  );
  const fileName = `dictation${DICTATION_EXTENSION_BY_MIME_TYPE[mimeType]}`;
  const filePath = path.join(tempDir, fileName);

  try {
    await fs.writeFile(filePath, params.audio, { mode: 0o600 });
    const result = await transcribeAudioWithFallback({
      filePath,
      fileName,
      mimeType,
      config,
      models,
      abortSignal: params.abortSignal,
    });
    if (!result) {
      throw new GatewayRequestError(
        502,
        'The recording could not be transcribed.',
      );
    }
    const text = result.text.trim();
    if (!text) {
      throw new GatewayRequestError(
        422,
        'No speech was detected in the recording.',
      );
    }
    return text;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
