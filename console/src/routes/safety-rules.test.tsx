/**
 * Operator edits remain local until saved and failed saves retain the draft.
 * These UI checks do not substitute for the authenticated gateway boundary tests.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import type { SafetyRulesResponse } from '../../../container/shared/safety-rules.js';
import { fetchSafetyRules, saveSafetyRules } from '../api/safety-rules';
import { mockRouterBlocker, renderWithProviders } from '../test-utils';
import { SafetyRulesPage } from './safety-rules';

vi.mock('@tanstack/react-router', () => mockRouterBlocker());
vi.mock('../auth', () => ({ useAuth: () => ({ token: 'test-token' }) }));
vi.mock('../api/safety-rules', () => ({
  fetchSafetyRules: vi.fn(),
  saveSafetyRules: vi.fn(),
}));
const state: SafetyRulesResponse = {
  disabledRuleIds: [],
  rules: [
    {
      id: 'recursive-delete',
      reason: 'Recursive or forced deletion',
      scope: 'bash',
      pattern: '/rm/',
      enabled: true,
    },
  ],
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchSafetyRules).mockResolvedValue(state);
});
test('lists actual server rules, saves explicit changes and restores defaults', async () => {
  vi.mocked(saveSafetyRules).mockImplementation(
    async (_token, disabledRuleIds) => ({ ...state, disabledRuleIds }),
  );
  renderWithProviders(<SafetyRulesPage />);
  const control = await screen.findByRole('switch', {
    name: 'Enable recursive-delete',
  });
  expect(control.getAttribute('aria-checked')).toBe('true');
  expect(screen.getByText('/rm/')).toBeTruthy();
  fireEvent.click(control);
  expect(saveSafetyRules).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() =>
    expect(saveSafetyRules).toHaveBeenCalledWith(
      'test-token',
      ['recursive-delete'],
      [],
    ),
  );
  await screen.findByRole('status');
  fireEvent.click(screen.getByRole('button', { name: 'Enable all rules' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() =>
    expect(saveSafetyRules).toHaveBeenLastCalledWith(
      'test-token',
      [],
      ['recursive-delete'],
    ),
  );
});
test('keeps failed edits visible instead of claiming they were saved', async () => {
  vi.mocked(saveSafetyRules).mockRejectedValue(
    new Error('Safety rules changed. Reload before saving.'),
  );
  renderWithProviders(<SafetyRulesPage />);
  fireEvent.click(
    await screen.findByRole('switch', { name: 'Enable recursive-delete' }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  expect((await screen.findByRole('alert')).textContent).toContain(
    'Reload before saving',
  );
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
});
