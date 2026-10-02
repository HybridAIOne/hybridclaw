/**
 * The worker's stdin: the one input channel no tool can write to, read until
 * the first request arrives and never again.
 *
 * Bytes after a newline stay buffered for the next read, so a warm worker's
 * MCP frame and its first request may share a pipe chunk. Stdin is paused
 * between reads, never ended: closing it would stop a `docker run -i` worker.
 * NOT the follow-up path; later requests arrive as authenticated IPC files.
 */
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

import { readWarmWorkerFrame } from '../shared/warm-worker-frame.js';
import type { ContainerInput } from './types.js';

export function createLineReader(stream: Readable): () => Promise<string> {
  // Pipe chunks can split a multi-byte character; decoding each chunk alone
  // would turn both halves into U+FFFD.
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  const takeLine = (): string | null => {
    const nl = buffer.indexOf('\n');
    if (nl === -1) return null;
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    return line;
  };

  return () =>
    new Promise((resolve, reject) => {
      const buffered = takeLine();
      if (buffered !== null) {
        resolve(buffered);
        return;
      }
      const stop = () => {
        stream.removeListener('data', onData);
        stream.removeListener('error', onError);
        stream.pause();
      };
      const onData = (chunk: Buffer) => {
        buffer += decoder.write(chunk);
        const line = takeLine();
        if (line === null) return;
        stop();
        resolve(line);
      };
      const onError = (err: Error) => {
        stop();
        reject(err);
      };
      stream.on('data', onData);
      stream.on('error', onError);
      stream.resume();
    });
}

/**
 * Reads the first request. A warm worker gets its MCP frame first and starts
 * those connections without waiting, so they overlap the wait for a request.
 */
export async function readFirstInput(
  readLine: () => Promise<string>,
  connectMcp: (
    servers: NonNullable<ContainerInput['mcpServers']>,
  ) => Promise<unknown>,
): Promise<ContainerInput> {
  const first: unknown = JSON.parse(await readLine());
  const warmServers = readWarmWorkerFrame(first);
  if (!warmServers) return first as ContainerInput;
  connectMcp(warmServers as NonNullable<ContainerInput['mcpServers']>).catch(
    (error) => {
      console.error('[hybridclaw-agent] warm MCP connect failed:', error);
    },
  );
  return JSON.parse(await readLine()) as ContainerInput;
}
