import { register } from 'tsx/esm/api';

register();
await import('./transformers-embedding-worker.ts');
