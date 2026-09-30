/**
 * Admin calls that answer a device waiting with a short code. The device's own
 * calls (`/api/device/code`, `/api/device/token`) are not made from the console.
 */
import { requestJson } from './client';

export interface DeviceRequest {
  userCode: string;
  clientName: string;
  sourceIp: string | null;
  expiresAt: string;
}

function devicePath(code: string): string {
  return `/api/admin/devices/${encodeURIComponent(code.trim())}`;
}

export function fetchDeviceRequest(
  token: string,
  code: string,
): Promise<{ device: DeviceRequest }> {
  return requestJson(devicePath(code), { token });
}

export function answerDeviceRequest(
  token: string,
  code: string,
  approve: boolean,
): Promise<{ device: DeviceRequest }> {
  return requestJson(devicePath(code), {
    token,
    method: 'POST',
    body: { approve },
  });
}
