import {
  resolveOutputGuardConfig,
  resolveOutputGuardProfileSelection,
} from './config.js';
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
    const profileCount = Object.keys(config.profiles).length;
    const channelProfileCount = Object.keys(config.channelProfiles).length;
    api.registerMiddleware(createOutputGuardMiddleware({ api, config }));

    api.registerCommand({
      name: 'output-guard',
      description: 'Show output guard status and configured rules.',
      handler(_args, context) {
        const selection = resolveOutputGuardProfileSelection(
          config,
          context.channelId,
        );
        const activeProfile = selection.profile;
        const channelProfile = selection.fellBack
          ? `${selection.requestedProfileId} (missing -> default)`
          : selection.profileId;
        return [
          'Output guard status:',
          `  mode: ${config.mode}`,
          `  failure mode: ${config.failureMode}`,
          `  channel profile: ${channelProfile}`,
          `  named profiles: ${profileCount}`,
          `  channel mappings: ${channelProfileCount}`,
          `  policy brief: ${activeProfile.policy ? 'configured' : '(none)'}`,
          `  policy file: ${activeProfile.policyFileText ? 'loaded' : '(none)'}`,
          `  do list: ${activeProfile.doList.length}`,
          `  don't list: ${activeProfile.dontList.length}`,
          `  banned phrases: ${activeProfile.bannedPhrases.length}`,
          `  banned patterns: ${activeProfile.bannedPatterns.length}`,
          `  required phrases: ${activeProfile.requirePhrases.length}`,
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
        bannedPhrases: config.defaultProfile.bannedPhrases.length,
        doList: config.defaultProfile.doList.length,
        dontList: config.defaultProfile.dontList.length,
        bannedPatterns: config.defaultProfile.bannedPatterns.length,
        requirePhrases: config.defaultProfile.requirePhrases.length,
        profiles: profileCount,
        channelProfiles: channelProfileCount,
        classifierProvider: config.classifier.provider,
        rewriterProvider: config.rewriter.provider,
      },
      'output-guard plugin registered',
    );
  },
};
