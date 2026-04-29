import { resolveBrandVoiceConfig } from './config.js';
import { createBrandVoiceGuard } from './guard.js';

export default {
  id: 'brand-voice',
  kind: 'output-guard',
  register(api) {
    const config = resolveBrandVoiceConfig(
      api.pluginConfig || {},
      api.runtime,
      api.logger,
    );
    if (!config.enabled) {
      api.logger.info({}, 'brand-voice plugin disabled by config');
      return;
    }
    api.registerOutputGuard(createBrandVoiceGuard({ api, config }));

    api.registerCommand({
      name: 'brand-voice',
      description: 'Show brand-voice guard status and configured rules.',
      handler() {
        return [
          'Brand-voice guard status:',
          `  mode: ${config.mode}`,
          `  failure mode: ${config.failureMode}`,
          `  voice brief: ${config.voice ? 'configured' : '(none)'}`,
          `  voice file: ${config.voiceFileText ? 'loaded' : '(none)'}`,
          `  banned phrases: ${config.bannedPhrases.length}`,
          `  banned patterns: ${config.bannedPatterns.length}`,
          `  required phrases: ${config.requirePhrases.length}`,
          `  classifier: ${config.classifier.provider}${
            config.classifier.provider !== 'none'
              ? ` (${config.classifier.model})`
              : ''
          }`,
          `  rewriter: ${config.rewriter.provider}${
            config.rewriter.provider !== 'none'
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
        bannedPatterns: config.bannedPatterns.length,
        requirePhrases: config.requirePhrases.length,
        classifierProvider: config.classifier.provider,
        rewriterProvider: config.rewriter.provider,
      },
      'brand-voice plugin registered',
    );
  },
};
