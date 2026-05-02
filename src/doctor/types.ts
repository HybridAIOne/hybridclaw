export const DOCTOR_CATEGORIES = [
  'runtime',
  'gateway',
  'config',
  'credentials',
  'database',
  'providers',
  'local-backends',
  'browser-use',
  'docker',
  'channels',
  'skills',
  'security',
  'disk',
] as const;

export type DoctorCategory = (typeof DOCTOR_CATEGORIES)[number];

export interface DiagFix {
  summary: string;
  apply: () => Promise<void>;
  rollback?: () => Promise<void>;
  requiresApproval?: boolean;
}

export interface DiagResult {
  category: DoctorCategory;
  label: string;
  severity: 'ok' | 'warn' | 'error';
  message: string;
  fix?: DiagFix;
}

export interface DoctorCheck {
  category: DoctorCategory;
  label: string;
  run: () => Promise<DiagResult[]>;
}

export interface DoctorArgs {
  component: DoctorCategory | null;
  fix: boolean;
  json: boolean;
}

export interface DoctorFixOutcome {
  category: string;
  label: string;
  status: 'applied' | 'failed' | 'skipped' | 'rolled_back' | 'rollback_failed';
  message: string;
}

export interface DoctorReport {
  generatedAt: string;
  component: string | null;
  results: Array<DiagResult & { fixable: boolean }>;
  summary: {
    ok: number;
    warn: number;
    error: number;
    exitCode: number;
  };
  fixes: DoctorFixOutcome[];
}
