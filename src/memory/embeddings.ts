import path from 'node:path';

import { DEFAULT_RUNTIME_HOME_DIR } from '../config/runtime-paths.js';

export type MemoryEmbeddingProviderKind = 'hashed' | 'transformers';
export type MemoryEmbeddingDtype = 'fp32' | 'q8' | 'q4';
export type MemoryEmbeddingInputKind = 'query' | 'document';

export interface MemoryEmbeddingRuntimeConfig {
  provider: MemoryEmbeddingProviderKind;
  model: string;
  revision: string;
  dtype: MemoryEmbeddingDtype;
}

export const DEFAULT_MEMORY_EMBEDDING_PROVIDER: MemoryEmbeddingProviderKind =
  'hashed';
export const DEFAULT_MEMORY_TRANSFORMERS_MODEL =
  'onnx-community/embeddinggemma-300m-ONNX';
export const DEFAULT_MEMORY_TRANSFORMERS_REVISION =
  '75a84c732f1884df76bec365346230e32f582c82';
export const DEFAULT_MEMORY_TRANSFORMERS_DTYPE: MemoryEmbeddingDtype = 'q8';

export function normalizeMemoryEmbeddingProviderKind(
  value: unknown,
  fallback: MemoryEmbeddingProviderKind,
): MemoryEmbeddingProviderKind {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (normalized === 'transformers' || normalized === 'transformers.js') {
    return 'transformers';
  }
  if (normalized === 'hashed' || normalized === 'hash') {
    return 'hashed';
  }
  return fallback;
}

export function normalizeMemoryEmbeddingDtype(
  value: unknown,
  fallback: MemoryEmbeddingDtype,
): MemoryEmbeddingDtype {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (normalized === 'fp32') {
    return 'fp32';
  }
  if (normalized === 'q4') {
    return 'q4';
  }
  if (normalized === 'q8') {
    return 'q8';
  }
  return fallback;
}

export function getDefaultMemoryEmbeddingCacheDir(
  homeDir = DEFAULT_RUNTIME_HOME_DIR,
): string {
  return path.join(homeDir, 'cache', 'transformers');
}
