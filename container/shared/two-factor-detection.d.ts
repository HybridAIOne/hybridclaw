export declare const TWO_FACTOR_MODALITIES: readonly [
  'totp',
  'push',
  'qr',
  'sms',
  'recovery_code',
];

export type TwoFactorModality = (typeof TWO_FACTOR_MODALITIES)[number];

export interface BrowserTextPreview {
  url: string;
  title: string;
  text_length: number;
  preview: string;
  preview_truncated: boolean;
  has_noscript: boolean;
  root_shell: boolean;
  ready_state: string;
}

export interface BrowserTwoFactorPageState {
  url: string;
  title: string;
  preview: string;
  textLength: number;
  previewTruncated: boolean;
  hasNoscript: boolean;
  rootShell: boolean;
  readyState: string;
  selectors: string[];
}

export interface TwoFactorDetectionInput {
  args?: Record<string, unknown>;
  title?: string | null;
  text?: string | null;
  selectors?: string[];
}

export interface TwoFactorDetectionResult {
  detected: boolean;
  modality: TwoFactorModality | null;
  signals: string[];
  selectors: string[];
  textPreview?: string;
}

export declare const EXTRACT_TEXT_PREVIEW_FUNCTION_SOURCE: string;
export declare const EXTRACT_TEXT_PREVIEW_SCRIPT: string;
export declare const TWO_FACTOR_SELECTOR_HINTS_FUNCTION_SOURCE: string;
export declare const TWO_FACTOR_SELECTOR_HINTS_SCRIPT: string;
export declare const EXTRACT_TWO_FACTOR_PAGE_STATE_FUNCTION_SOURCE: string;
export declare const EXTRACT_TWO_FACTOR_PAGE_STATE_SCRIPT: string;

export declare function normalizeTwoFactorModality(
  value: unknown,
): TwoFactorModality | null;

export declare function hasExpectedTwoFactorWaypoint(
  args: Record<string, unknown>,
): boolean;

export declare function llmSignaledTwoFactor(
  args: Record<string, unknown>,
): boolean;

export declare function detectTwoFactorChallenge(
  input: TwoFactorDetectionInput,
): TwoFactorDetectionResult;
