import {
  normalizeConciergeProfileName,
  resolveConciergeProfileModel,
} from './routing.js';

function formatModelForDisplay(model) {
  const trimmed = String(model || '').trim();
  if (!trimmed) return '';
  if (
    /^(hybridai|openai|openai-codex|anthropic|openrouter|mistral|huggingface|ollama|lmstudio|llamacpp|vllm)\//i.test(
      trimmed,
    )
  ) {
    return trimmed;
  }
  return `hybridai/${trimmed}`;
}

function parseIdArg(args, index) {
  return String(args[index] || '').trim();
}

function parseLowerArg(args, index) {
  return parseIdArg(args, index).toLowerCase();
}

function formatConciergeProfileLabel(profile) {
  if (profile === 'asap') return 'asap';
  if (profile === 'balanced') return 'balanced';
  return 'no_hurry';
}

function info(title, text) {
  return { kind: 'info', title, text };
}

function plain(text) {
  return { kind: 'plain', text };
}

function error(title, text) {
  return { kind: 'error', title, text };
}

function buildConciergeInfoText(concierge) {
  return [
    `Enabled: ${concierge.enabled ? 'on' : 'off'}`,
    `Decision model: ${formatModelForDisplay(concierge.model)}`,
    '',
    'Profiles:',
    `asap: ${formatModelForDisplay(concierge.profiles.asap)}`,
    `balanced: ${formatModelForDisplay(concierge.profiles.balanced)}`,
    `no_hurry: ${formatModelForDisplay(concierge.profiles.noHurry)}`,
  ].join('\n');
}

export function createConciergeCommandHandler(api, getConfig, setConfig) {
  return async (args) => {
    const sub = parseLowerArg(args, 0);
    const concierge = getConfig();

    if (!sub || sub === 'info') {
      return info('Concierge Routing', buildConciergeInfoText(concierge));
    }

    if (sub === 'on' || sub === 'enable') {
      await api.writeConfigValue('enabled', 'true');
      setConfig({ ...concierge, enabled: true });
      return plain(
        `Concierge routing enabled. Decision model: \`${formatModelForDisplay(concierge.model)}\`.`,
      );
    }

    if (sub === 'off' || sub === 'disable') {
      await api.writeConfigValue('enabled', 'false');
      setConfig({ ...concierge, enabled: false });
      return plain('Concierge routing disabled.');
    }

    if (sub === 'model') {
      const modelName = parseIdArg(args, 1);
      if (!modelName) {
        return info(
          'Concierge Model',
          [
            `Enabled: ${concierge.enabled ? 'on' : 'off'}`,
            `Decision model: ${formatModelForDisplay(concierge.model)}`,
          ].join('\n'),
        );
      }
      await api.writeConfigValue('model', modelName);
      setConfig({ ...concierge, model: modelName });
      return plain(
        `Concierge decision model set to \`${formatModelForDisplay(modelName)}\`.`,
      );
    }

    if (sub === 'profile') {
      const profile = normalizeConciergeProfileName(parseIdArg(args, 1));
      if (!profile) {
        return error(
          'Usage',
          'Usage: `concierge profile <asap|balanced|no_hurry> [model]`',
        );
      }
      const configuredModel = resolveConciergeProfileModel(concierge, profile);
      const modelName = parseIdArg(args, 2);
      if (!modelName) {
        return info(
          'Concierge Profile',
          `${formatConciergeProfileLabel(profile)}: ${formatModelForDisplay(configuredModel)}`,
        );
      }
      const nextProfiles = {
        asap: concierge.profiles.asap,
        balanced: concierge.profiles.balanced,
        noHurry: concierge.profiles.noHurry,
      };
      if (profile === 'asap') nextProfiles.asap = modelName;
      if (profile === 'balanced') nextProfiles.balanced = modelName;
      if (profile === 'no_hurry') nextProfiles.noHurry = modelName;
      await api.writeConfigValue('profiles', JSON.stringify(nextProfiles));
      setConfig({ ...concierge, profiles: nextProfiles });
      return plain(
        `Concierge profile \`${formatConciergeProfileLabel(profile)}\` set to \`${formatModelForDisplay(modelName)}\`.`,
      );
    }

    return error(
      'Usage',
      'Usage: `concierge [info|on|off|model [name]|profile <asap|balanced|no_hurry> [model]]`',
    );
  };
}
