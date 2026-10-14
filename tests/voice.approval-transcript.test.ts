import { afterEach, expect, test, vi } from 'vitest';
import { ApprovalTranscript } from '../src/voice/approval-transcript.js';
afterEach(() => vi.useRealTimers());

test('only a fresh caller transcript can be consumed, once', async () => {
  const input = new ApprovalTranscript();
  expect(await input.take()).toBeNull();
  input.begin('utterance-a');
  input.complete('utterance-a', 'Bitte sende den Entwurf.');
  expect(await input.take()).toBe('Bitte sende den Entwurf.');
  expect(await input.take()).toBeNull();
  input.complete('utterance-a', 'duplicate transcription');
  expect(await input.take()).toBeNull();
});

test('waits for late STT and ignores older utterances', async () => {
  const input = new ApprovalTranscript();
  input.begin('a');
  input.begin('b');
  const result = input.take();
  input.complete('a', 'stale consent');
  input.complete('b', 'Nein');
  expect(await result).toBe('Nein');
  expect(await input.take()).toBeNull();
});

test('a new utterance invalidates a pending transcript read', async () => {
  const input = new ApprovalTranscript();
  input.begin('a');
  const result = input.take();
  input.begin('b');
  input.complete('a', 'stale');
  input.complete('b', 'current');
  expect(await result).toBeNull();
  expect(await input.take()).toBe('current');
});

test('missing STT times out without substituting generated text', async () => {
  vi.useFakeTimers();
  const input = new ApprovalTranscript();
  input.begin('a');
  const result = input.take();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(await result).toBeNull();
  input.complete('a', 'too late');
  expect(await input.take()).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

test('closing a call cancels its pending read', async () => {
  vi.useFakeTimers();
  const input = new ApprovalTranscript();
  input.begin('a');
  const result = input.take();
  input.close();
  expect(await result).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});


test('unidentified speech cannot supply consent', async () => {
  const input = new ApprovalTranscript();
  input.begin('');
  input.complete('', 'yes');
  expect(await input.take()).toBeNull();
});
