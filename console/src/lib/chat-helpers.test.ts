import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApprovalCommand, copyToClipboard } from './chat-helpers';

describe('buildApprovalCommand', () => {
  it('builds gateway-supported approval commands', () => {
    expect(buildApprovalCommand('once', ' approve-1 ')).toBe(
      '/approve yes approve-1',
    );
    expect(buildApprovalCommand('session', 'approve-1')).toBe(
      '/approve session approve-1',
    );
    expect(buildApprovalCommand('all', 'approve-1')).toBe(
      '/approve all approve-1',
    );
    expect(buildApprovalCommand('deny', 'approve-1')).toBe(
      '/approve no approve-1',
    );
  });
});

describe('copyToClipboard', () => {
  const originalClipboard = Object.getOwnPropertyDescriptor(
    navigator,
    'clipboard',
  );
  const originalExecCommand = document.execCommand;

  afterEach(() => {
    if (originalClipboard)
      Object.defineProperty(navigator, 'clipboard', originalClipboard);
    else Reflect.deleteProperty(navigator as unknown as object, 'clipboard');
    document.execCommand = originalExecCommand;
    vi.restoreAllMocks();
  });

  function setClipboard(value: unknown): void {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value,
    });
  }

  it('uses the async Clipboard API and resolves true on success', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    // Make sure a stray execCommand isn't what reports success.
    document.execCommand = vi.fn(() => false) as typeof document.execCommand;

    await expect(copyToClipboard('hello')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
    expect(document.execCommand).not.toHaveBeenCalled();
  });

  it('falls back to execCommand when the Clipboard API rejects', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    setClipboard({ writeText });
    document.execCommand = vi.fn(() => true) as typeof document.execCommand;

    await expect(copyToClipboard('hello')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalled();
    expect(document.execCommand).toHaveBeenCalledWith('copy');
  });

  it('falls back to execCommand when the Clipboard API is unavailable', async () => {
    // Regression: the previous `navigator.clipboard?.writeText(...).catch(...)`
    // short-circuited the whole chain when clipboard was absent, so the
    // fallback never ran.
    setClipboard(undefined);
    document.execCommand = vi.fn(() => true) as typeof document.execCommand;

    await expect(copyToClipboard('hello')).resolves.toBe(true);
    expect(document.execCommand).toHaveBeenCalledWith('copy');
  });

  it('resolves false when no copy mechanism succeeds', async () => {
    setClipboard(undefined);
    document.execCommand = vi.fn(() => false) as typeof document.execCommand;

    await expect(copyToClipboard('hello')).resolves.toBe(false);
  });
});
