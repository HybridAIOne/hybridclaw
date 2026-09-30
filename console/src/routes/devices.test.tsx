import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceRequest } from '../api/devices';
import { renderWithProviders } from '../test-utils';
import { DevicesPage } from './devices';

const fetchDeviceRequestMock = vi.fn();
const answerDeviceRequestMock = vi.fn();
const searchMock = vi.fn();

vi.mock('../api/devices', () => ({
  fetchDeviceRequest: (token: string, code: string) =>
    fetchDeviceRequestMock(token, code),
  answerDeviceRequest: (token: string, code: string, approve: boolean) =>
    answerDeviceRequestMock(token, code, approve),
}));

vi.mock('../auth', () => ({
  useAuth: () => ({ token: 'test-token' }),
}));

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>(
    '@tanstack/react-router',
  );
  return { ...actual, useSearch: () => searchMock() };
});

const device: DeviceRequest = {
  userCode: 'bcdf-ghjk',
  clientName: 'HybridClaw for iPhone',
  sourceIp: '192.168.1.20',
  expiresAt: '2026-09-30T12:10:00.000Z',
};

describe('DevicesPage', () => {
  beforeEach(() => {
    fetchDeviceRequestMock.mockReset();
    answerDeviceRequestMock.mockReset();
    searchMock.mockReturnValue({});
  });

  it('opens on the code from the link and approves that device', async () => {
    searchMock.mockReturnValue({ code: 'bcdf-ghjk' });
    fetchDeviceRequestMock.mockResolvedValue({ device });
    answerDeviceRequestMock.mockResolvedValue({ device });
    renderWithProviders(<DevicesPage />);

    expect(
      await screen.findByText('HybridClaw for iPhone asks to connect'),
    ).toBeTruthy();
    expect(fetchDeviceRequestMock).toHaveBeenCalledWith(
      'test-token',
      'bcdf-ghjk',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(
      await screen.findByText(
        'Approved. The device finishes connecting by itself.',
      ),
    ).toBeTruthy();
    expect(answerDeviceRequestMock).toHaveBeenCalledWith(
      'test-token',
      'bcdf-ghjk',
      true,
    );
  });

  it('looks up a typed code and says when nothing is waiting', async () => {
    fetchDeviceRequestMock.mockRejectedValue(
      new Error('No device is waiting with this code.'),
    );
    renderWithProviders(<DevicesPage />);

    expect(fetchDeviceRequestMock).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Code shown on the device'), {
      target: { value: ' wxyz-2345 ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Find device' }));
    await waitFor(() =>
      expect(fetchDeviceRequestMock).toHaveBeenCalledWith(
        'test-token',
        'wxyz-2345',
      ),
    );
    expect(
      await screen.findByText('No device is waiting with this code.'),
    ).toBeTruthy();
    expect(answerDeviceRequestMock).not.toHaveBeenCalled();
  });
});
