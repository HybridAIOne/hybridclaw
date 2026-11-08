/**
 * UI saves preserve the selected scope and observed mode; rejected edits remain drafts.
 * Auth and durable session semantics are covered at the real gateway boundary.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import type { ApprovalSettingsResponse } from '../../../container/shared/approval-mode.js';
import {
  fetchApprovalSettings,
  saveApprovalSettings,
} from '../api/approval-settings';
import { mockRouterBlocker, renderWithProviders } from '../test-utils';
import { ApprovalSettingsPage } from './approval-settings';

vi.mock('../api/approval-settings');
vi.mock('../auth', () => ({ useAuth: () => ({ token: 'test-token' }) }));
vi.mock('@tanstack/react-router', () => mockRouterBlocker());
const data: ApprovalSettingsResponse = {
  defaultMode: 'auto',
  sessions: [
    {
      id: 'test-session',
      agentId: 'main',
      channelId: 'web',
      storedMode: 'auto',
      effectiveMode: 'auto',
    },
  ],
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fetchApprovalSettings).mockResolvedValue(structuredClone(data));
});

test('selecting a default stages it; saving sends the expected mode without changing a conversation', async () => {
  vi.mocked(saveApprovalSettings).mockResolvedValue({
    ...data,
    defaultMode: 'learning',
  });
  renderWithProviders(<ApprovalSettingsPage />);
  fireEvent.change(
    await screen.findByRole('combobox', {
      name: 'Default for new conversations',
    }),
    { target: { value: 'learning' } },
  );
  expect(saveApprovalSettings).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Save default' }));
  await waitFor(() =>
    expect(saveApprovalSettings).toHaveBeenCalledWith(expect.any(String), {
      target: 'default',
      mode: 'learning',
      expectedMode: 'auto',
    }),
  );
  expect(await screen.findByRole('status')).toBeTruthy();
});

test('session errors retain the draft and cannot be mistaken for a global save', async () => {
  vi.mocked(saveApprovalSettings).mockRejectedValue(
    new Error('Session mode changed. Reload before saving.'),
  );
  renderWithProviders(<ApprovalSettingsPage />);
  fireEvent.change(
    await screen.findByRole('combobox', { name: 'Conversation' }),
    { target: { value: 'test-session' } },
  );
  const mode = await screen.findByRole('combobox', {
    name: 'Conversation approval mode',
  });
  fireEvent.change(mode, { target: { value: 'learning' } });
  expect(
    (
      screen.getByRole('combobox', {
        name: 'Conversation',
      }) as HTMLSelectElement
    ).disabled,
  ).toBe(true);
  fireEvent.click(
    screen.getByRole('button', { name: 'Save conversation mode' }),
  );
  expect((await screen.findByRole('alert')).textContent).toContain('Reload');
  expect(saveApprovalSettings).toHaveBeenCalledWith(expect.any(String), {
    target: 'session',
    sessionId: 'test-session',
    mode: 'learning',
    expectedMode: 'auto',
  });
  expect((mode as HTMLSelectElement).value).toBe('learning');
  expect(
    (
      screen.getByRole('combobox', {
        name: 'Default for new conversations',
      }) as HTMLSelectElement
    ).value,
  ).toBe('auto');
});
