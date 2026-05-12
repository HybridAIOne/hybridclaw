export interface AdditionalMount {
  hostPath: string;
  containerPath?: string | undefined;
  readonly?: boolean | undefined;
}

export interface MountAllowlist {
  allowedRoots: AllowedRoot[];
  blockedPatterns: string[];
}

export interface AllowedRoot {
  path: string;
  allowReadWrite: boolean;
  description?: string | undefined;
}
