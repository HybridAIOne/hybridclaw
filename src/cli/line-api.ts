import { makeLazyApi } from './common.js';

type LineAuthApi = typeof import('../channels/line/auth.js');
type LineConnectionApi = typeof import('../channels/line/connection.js');

const authState = makeLazyApi<LineAuthApi>(
  () => import('../channels/line/auth.js'),
  'LINE auth API accessed before initialization.',
);
const connectionState = makeLazyApi<LineConnectionApi>(
  () => import('../channels/line/connection.js'),
  'LINE connection API accessed before initialization.',
);

export const ensureLineAuthApi = (): Promise<LineAuthApi> => authState.ensure();
export const getLineAuthApi = (): LineAuthApi => authState.get();
export const ensureLineConnectionApi = (): Promise<LineConnectionApi> =>
  connectionState.ensure();
export const getLineConnectionApi = (): LineConnectionApi =>
  connectionState.get();
