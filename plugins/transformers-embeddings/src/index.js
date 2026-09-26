import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { TransformersJsEmbeddingProvider } from './provider.js';

export default {
  id: 'transformers-embeddings',
  register(api) {
    const config = api.pluginConfig;
    const model = String(config.model);
    api.registerEmbeddingProvider({
      id: 'transformers',
      model,
      create() {
        return new TransformersJsEmbeddingProvider({
          model,
          revision: String(config.revision),
          dtype: String(config.dtype),
          cacheDir:
            config.cacheDir ||
            path.join(api.runtime.homeDir, 'cache', 'transformers'),
          // Load the worker from the installed plugin directory, next to its
          // node_modules, not from the temporary import snapshot.
          workerUrl: pathToFileURL(api.resolvePath('src/worker.js')),
          logger: api.logger.child({ component: 'transformers-embedding' }),
        });
      },
    });
  },
};
