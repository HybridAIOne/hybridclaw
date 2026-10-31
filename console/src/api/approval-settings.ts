/**
 * Admin approval settings use the gateway's stored snapshot and conditional saves.
 * This client does not emulate slash commands or grant pending tool consent.
 */
import type {
  ApprovalSettingsResponse,
  ApprovalSettingsUpdate,
} from '../../../container/shared/approval-mode.js';
import { requestJson } from './client';

export function fetchApprovalSettings(token: string) {
  return requestJson<ApprovalSettingsResponse>('/api/admin/approval-settings', {
    token,
  });
}

export function saveApprovalSettings(
  token: string,
  body: ApprovalSettingsUpdate,
) {
  return requestJson<ApprovalSettingsResponse>('/api/admin/approval-settings', {
    token,
    method: 'PUT',
    body,
  });
}
