import {
  getRuntimeConfig,
  getRuntimeDisabledToolNames,
} from '../config/runtime-config.js';
import { normalizeTrimmedStringSet } from '../utils/normalized-strings.js';

export function mergeBlockedToolNames(params?: {
  explicit?: readonly string[] | null;
  runtimeDisabled?: Iterable<string>;
}): string[] | undefined {
  const explicit = Array.isArray(params?.explicit) ? params.explicit : [];
  const runtimeDisabled =
    params?.runtimeDisabled ?? getRuntimeDisabledToolNames(getRuntimeConfig());
  const merged = [
    ...normalizeTrimmedStringSet([...explicit, ...runtimeDisabled]),
  ];
  return merged.length > 0 ? merged : undefined;
}
