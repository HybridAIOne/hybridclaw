import { makeLazyApi } from './common.js';

type LineAuthApi = typeof import('../channels/line/auth.js');

const authState = makeLazyApi<LineAuthApi>(
  () => import('../channels/line/auth.js'),
  'LINE auth API accessed before initialization.',
);

export const ensureLineAuthApi = (): Promise<LineAuthApi> => authState.ensure();
export const getLineAuthApi = (): LineAuthApi => authState.get();
