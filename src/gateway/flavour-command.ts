/**
 * `/flavour` — which model family the agent thinks with: `openai`,
 * `anthropic`, or `eu` for an open-weight model hosted in the EU. It sets the
 * agent's own model, so every chat and scheduled task of the agent follows,
 * and leaves the auxiliary model alone. Companion apps read and set it from
 * their settings with `--json`, answered in one line that survives a chat
 * relay (`chatSafeJson`).
 */
import { stripHybridAIModelPrefix } from '../../container/shared/model-names.js';
import {
  getStoredAgentConfig,
  resolveAgentModel,
  upsertRegisteredAgent,
} from '../agents/agent-registry.js';
import { HYBRIDAI_MODEL } from '../config/config.js';
import { updateSessionModel } from '../memory/sessions.js';
import { getDiscoveredHybridAIModelNames } from '../providers/hybridai-discovery.js';
import { refreshAvailableModelCatalogs } from '../providers/model-catalog.js';
import type { Session } from '../types/session.js';
import { badCommand, plainCommand } from './gateway-command-results.js';
import type {
  GatewayCommandRequest,
  GatewayCommandResult,
} from './gateway-types.js';
import { chatSafeJson } from './schedule-command.js';

export const FLAVOUR_MODELS = {
  openai: 'hybridai/gpt-6-luna',
  anthropic: 'hybridai/anthropic/claude-haiku-5-5',
  eu: 'hybridai/melious/glm-5.3-flash',
} as const;

type Flavour = keyof typeof FLAVOUR_MODELS;
const FLAVOURS = Object.keys(FLAVOUR_MODELS) as Flavour[];

const USAGE =
  'Usage: `/flavour` shows which models the agent uses, `/flavour set openai|anthropic|eu` changes it. Add `--json` for a machine-readable answer.';

// `gpt-6-luna` and `hybridai/gpt-6-luna` name the same model.
const modelKey = (model: string) =>
  stripHybridAIModelPrefix(model).toLowerCase();

function flavourOf(model: string): Flavour | null {
  return (
    FLAVOURS.find(
      (flavour) => modelKey(FLAVOUR_MODELS[flavour]) === modelKey(model),
    ) ?? null
  );
}

// The flavours whose model the HybridAI catalog offers; all of them while the
// catalog can't be read, so a missing catalog never locks the choice.
async function availableFlavours(): Promise<Flavour[]> {
  await refreshAvailableModelCatalogs({ includeHybridAI: true });
  const offered = new Set(getDiscoveredHybridAIModelNames().map(modelKey));
  if (offered.size === 0) return FLAVOURS;
  return FLAVOURS.filter((flavour) =>
    offered.has(modelKey(FLAVOUR_MODELS[flavour])),
  );
}

async function answer(
  agentId: string,
  json: boolean,
): Promise<GatewayCommandResult> {
  const model =
    resolveAgentModel(getStoredAgentConfig(agentId)) || HYBRIDAI_MODEL;
  const flavour = flavourOf(model);
  if (json) {
    const available = await availableFlavours();
    return plainCommand(
      chatSafeJson({ version: 1, flavour, model, available }),
    );
  }
  return plainCommand(
    flavour
      ? `The agent uses ${flavour} models (${model}).`
      : `The agent uses ${model}, which isn't one of the flavours. Pick one with \`/flavour set openai|anthropic|eu\`.`,
  );
}

export async function handleFlavourCommand(
  req: GatewayCommandRequest,
  session: Session,
  agentId: string,
): Promise<GatewayCommandResult> {
  const rest = req.args.slice(1).map(String);
  const json = rest.includes('--json');
  const [sub = 'show', ...operands] = rest.filter((arg) => arg !== '--json');
  const action = sub.toLowerCase();
  if (action === 'show' && operands.length === 0) return answer(agentId, json);
  if (action !== 'set' || operands.length !== 1) {
    return badCommand('Usage', USAGE);
  }
  const flavour = operands[0].toLowerCase() as Flavour;
  if (!FLAVOURS.includes(flavour)) return badCommand('Usage', USAGE);
  if (!(await availableFlavours()).includes(flavour)) {
    return badCommand(
      'Flavour',
      `${FLAVOUR_MODELS[flavour]} isn't offered by HybridAI yet, so the agent stays as it is.`,
    );
  }
  upsertRegisteredAgent({
    ...(getStoredAgentConfig(agentId) ?? { id: agentId }),
    model: FLAVOUR_MODELS[flavour],
  });
  // This chat follows right away; a model pinned here would otherwise win.
  updateSessionModel(session.id, null);
  return answer(agentId, json);
}
