import { Writable } from 'node:stream';

import pino from 'pino';
import pinoPretty from 'pino-pretty';
import { describe, expect, it } from 'vitest';

import {
  LOGGER_ERROR_KEY,
  LOGGER_PRETTY_OPTIONS,
  LOGGER_SERIALIZERS,
} from '../src/logger-format.ts';

function renderLogLines(writeEntries: (logger: pino.Logger) => void): string[] {
  const pretty = pinoPretty.prettyFactory({
    ...LOGGER_PRETTY_OPTIONS,
    colorize: false,
  });
  let output = '';
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      output += pretty(chunk.toString('utf-8'));
      callback();
    },
  });
  const logger = pino(
    {
      errorKey: LOGGER_ERROR_KEY,
      serializers: LOGGER_SERIALIZERS,
    },
    destination,
  );

  writeEntries(logger);
  return output.trim().split('\n');
}

describe('logger formatting', () => {
  it('renders full local dates in log timestamps', () => {
    const [line] = renderLogLines((logger) => {
      logger.info('Gateway started');
    });

    expect(line).toMatch(
      /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\]/,
    );
  });

  it('renders structured fields on one line as compact JSON', () => {
    const [line] = renderLogLines((logger) => {
      logger.info(
        {
          flags: ['workspace fencing', 'secret env scrubbing'],
          sandbox: { mode: 'host', runningInsideContainer: false },
        },
        'Gateway started',
      );
    });

    expect(line).toContain(
      'Gateway started {"flags":["workspace fencing","secret env scrubbing"],"sandbox":{"mode":"host","runningInsideContainer":false}}',
    );
  });

  it('serializes err and error objects onto a single line', () => {
    const lines = renderLogLines((logger) => {
      logger.error(
        { err: new Error('boom'), tags: ['retry'] },
        'Request failed',
      );
      logger.error({ error: new Error('kapow') }, 'Worker failed');
    });

    expect(lines[0]).toContain(
      'Request failed {"err":{"type":"Error","message":"boom","stack":"Error: boom',
    );
    expect(lines[0]).toContain('"tags":["retry"]}');
    expect(lines[1]).toContain(
      'Worker failed {"error":{"type":"Error","message":"kapow","stack":"Error: kapow',
    );
  });

  it('serializes DOMException errors without DOM constant fields', () => {
    const [line] = renderLogLines((logger) => {
      logger.warn(
        {
          error: new DOMException(
            'The operation was aborted due to timeout',
            'TimeoutError',
          ),
        },
        'Request timed out',
      );
    });

    expect(line).toContain(
      'Request timed out {"error":{"type":"DOMException","message":"The operation was aborted due to timeout"',
    );
    expect(line).toContain('"name":"TimeoutError"');
    expect(line).toContain('"code":23');
    expect(line).not.toContain('INDEX_SIZE_ERR');
    expect(line).not.toContain('DATA_CLONE_ERR');
  });
});
