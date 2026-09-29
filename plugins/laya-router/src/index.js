/** Local Laya is a decision runtime, never a chat or cloud fallback provider. */
import path from 'node:path';
import { LayaRuntime } from './runtime.js';
export default {
  id: 'laya-router',
  register(api) {
    const runtime = new LayaRuntime({
      home: path.join(api.runtime.homeDir, 'laya'),
      component: api.resolvePath('runtime'),
    });
    api.registerLocalClassifier({
      model: 'local-decision/laya',
      label: 'Laya · Typed decisions 421M',
      status: () => runtime.status(),
      command: (action) => runtime.command(action),
      predict: (input) => runtime.predict(input),
    });
    api.registerService({ id: 'laya', stop: () => runtime.stop() });
  },
};
