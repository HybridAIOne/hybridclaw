import { parseIdArg, parseLowerArg } from '../command-parsing.js';
import {
  getRuntimeConfig,
  updateRuntimeConfig,
} from '../config/runtime-config.js';
import { formatModelForDisplay } from '../providers/model-names.js';
import {
  normalizeConciergeProfileName,
  resolveConciergeProfileModel,
} from './concierge-routing.js';
import type { GatewayCommandResult } from './gateway-types.js';

interface ConciergeCommandContext {
  args: string[];
  badCommand: (title: string, text: string) => GatewayCommandResult;
  infoCommand: (title: string, text: string) => GatewayCommandResult;
  plainCommand: (text: string) => GatewayCommandResult;
  resolveValidatedRuntimeModelName: (
    rawModelName: string,
  ) => Promise<
    { ok: true; model: string } | { ok: false; result: GatewayCommandResult }
  >;
}

function formatConciergeProfileLabel(
  profile: 'asap' | 'balanced' | 'no_hurry',
): string {
  if (profile === 'asap') return 'asap';
  if (profile === 'balanced') return 'balanced';
  return 'no_hurry';
}

function buildConciergeInfoText(): string {
  const concierge = getRuntimeConfig().routing.concierge;
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

export async function handleConciergeCommand(
  context: ConciergeCommandContext,
): Promise<GatewayCommandResult> {
  const sub = parseLowerArg(context.args, 1);
  const concierge = getRuntimeConfig().routing.concierge;

  if (!sub || sub === 'info') {
    return context.infoCommand('Concierge Routing', buildConciergeInfoText());
  }

  if (sub === 'on' || sub === 'enable') {
    updateRuntimeConfig((draft) => {
      draft.routing.concierge.enabled = true;
    });
    return context.plainCommand(
      `Concierge routing enabled. Decision model: \`${formatModelForDisplay(getRuntimeConfig().routing.concierge.model)}\`.`,
    );
  }

  if (sub === 'off' || sub === 'disable') {
    updateRuntimeConfig((draft) => {
      draft.routing.concierge.enabled = false;
    });
    return context.plainCommand('Concierge routing disabled.');
  }

  if (sub === 'model') {
    const modelName = parseIdArg(context.args, 2);
    if (!modelName) {
      return context.infoCommand(
        'Concierge Model',
        [
          `Enabled: ${concierge.enabled ? 'on' : 'off'}`,
          `Decision model: ${formatModelForDisplay(concierge.model)}`,
        ].join('\n'),
      );
    }
    const resolvedModel =
      await context.resolveValidatedRuntimeModelName(modelName);
    if (!resolvedModel.ok) {
      return resolvedModel.result;
    }
    updateRuntimeConfig((draft) => {
      draft.routing.concierge.model = resolvedModel.model;
    });
    return context.plainCommand(
      `Concierge decision model set to \`${formatModelForDisplay(resolvedModel.model)}\`.`,
    );
  }

  if (sub === 'profile') {
    const profile = normalizeConciergeProfileName(parseIdArg(context.args, 2));
    if (!profile) {
      return context.badCommand(
        'Usage',
        'Usage: `concierge profile <asap|balanced|no_hurry> [model]`',
      );
    }
    const configuredModel = resolveConciergeProfileModel(
      getRuntimeConfig(),
      profile,
    );
    const modelName = parseIdArg(context.args, 3);
    if (!modelName) {
      return context.infoCommand(
        'Concierge Profile',
        `${formatConciergeProfileLabel(profile)}: ${formatModelForDisplay(configuredModel)}`,
      );
    }
    const resolvedModel =
      await context.resolveValidatedRuntimeModelName(modelName);
    if (!resolvedModel.ok) {
      return resolvedModel.result;
    }
    updateRuntimeConfig((draft) => {
      if (profile === 'asap') {
        draft.routing.concierge.profiles.asap = resolvedModel.model;
        return;
      }
      if (profile === 'balanced') {
        draft.routing.concierge.profiles.balanced = resolvedModel.model;
        return;
      }
      draft.routing.concierge.profiles.noHurry = resolvedModel.model;
    });
    return context.plainCommand(
      `Concierge profile \`${formatConciergeProfileLabel(profile)}\` set to \`${formatModelForDisplay(resolvedModel.model)}\`.`,
    );
  }

  return context.badCommand(
    'Usage',
    'Usage: `concierge [info|on|off|model [name]|profile <asap|balanced|no_hurry> [model]]`',
  );
}
