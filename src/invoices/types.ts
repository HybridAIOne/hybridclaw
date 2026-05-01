import type { SecretInput } from '../security/secret-refs.js';

export const INVOICE_PROVIDER_IDS = [
  'stripe',
  'github',
  'openai',
  'anthropic',
  'atlassian',
  'linkedin',
  'google-ads',
  'aws',
  'gcp',
  'azure',
] as const;

export type InvoiceProviderId = (typeof INVOICE_PROVIDER_IDS)[number];

export type InvoiceCredentials = Record<string, string>;
export type InvoiceCredentialInputs = Record<string, SecretInput | undefined>;

export interface InvoiceMeta {
  vendor: string;
  invoice_no: string;
  period: string;
  issue_date: string;
  due_date: string;
  net: number;
  vat_rate: number;
  vat: number;
  gross: number;
  currency: string;
  source_url: string;
}

export interface InvoiceRecord extends InvoiceMeta {
  pdf_path: string;
  checksum_sha256: string;
}

export interface InvoiceListOptions {
  since?: string;
}

export interface InvoiceAdapterContext {
  providerId: InvoiceProviderId | string;
  profileDir?: string;
}

export interface InvoiceAdapter<Session = unknown> {
  id: InvoiceProviderId | string;
  displayName: string;
  login(
    credentials: InvoiceCredentials,
    context: InvoiceAdapterContext,
  ): Promise<Session>;
  listInvoices(
    session: Session,
    options: InvoiceListOptions,
  ): Promise<InvoiceMeta[]>;
  download(session: Session, invoice: InvoiceMeta): Promise<Uint8Array>;
  close?(session: Session): void | Promise<void>;
}

export interface InvoiceHarvestDuplicate {
  reason: 'identity' | 'checksum';
  invoice: InvoiceMeta | InvoiceRecord;
}

export interface InvoiceHarvestResult {
  fetched: InvoiceRecord[];
  duplicates: InvoiceHarvestDuplicate[];
  manifestPath: string;
}
