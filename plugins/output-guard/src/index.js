import { resolveOutputGuardConfig } from './config.js';
import { createOutputGuardMiddleware } from './guard.js';

export default {
  id: 'output-guard',
  kind: 'output-guard',
  register(api) {
    const config = resolveOutputGuardConfig(
      api.pluginConfig || {},
      api.runtime,
      api.logger,
    );
    if (!config.enabled) {
      api.logger.info({}, 'output-guard plugin disabled by config');
      return;
    }
    api.registerMiddleware(createOutputGuardMiddleware({ api, config }));

    api.registerCommand({
      name: 'output-guard',
      description: 'Show output guard status and configured rules.',
      handler() {
        return [
          'Output guard status:',
          `  mode: ${config.mode}`,
          `  failure mode: ${config.failureMode}`,
          `  policy brief: ${config.policy ? 'configured' : '(none)'}`,
          `  policy file: ${config.policyFileText ? 'loaded' : '(none)'}`,
          `  do list: ${config.doList.length}`,
          `  don't list: ${config.dontList.length}`,
          `  banned phrases: ${config.bannedPhrases.length}`,
          `  banned patterns: ${config.bannedPatterns.length}`,
          `  required phrases: ${config.requirePhrases.length}`,
          `  classifier: ${config.classifier.provider}`,
          `  rewriter: ${config.rewriter.provider}${
            config.rewriter.provider === 'model'
              ? ` (${config.rewriter.model})`
              : ''
          }`,
        ].join('\n');
      },
    });

    api.logger.info(
      {
        mode: config.mode,
        bannedPhrases: config.bannedPhrases.length,
        doList: config.doList.length,
        dontList: config.dontList.length,
        bannedPatterns: config.bannedPatterns.length,
        requirePhrases: config.requirePhrases.length,
        classifierProvider: config.classifier.provider,
        rewriterProvider: config.rewriter.provider,
      },
      'output-guard plugin registered',
    );
  },
};
