import {
  doesNetworkHostPatternExpandToSubdomains,
  type NetworkPolicyAction,
  type NetworkRule,
  normalizeNetworkRule,
} from '../policy/network-policy.js';
import {
  applyPolicyPreset,
  listPolicyPresetSummaries,
  previewPolicyPreset,
  removePolicyPreset,
} from '../policy/policy-presets.js';
import {
  addPolicyRule,
  deletePolicyRule,
  type IndexedNetworkRule,
  type PolicyNetworkState,
  readPolicyState,
  resetPolicyNetwork,
  setPolicyDefault,
} from '../policy/policy-store.js';

export interface PolicyCommandOutput {
  kind: 'plain' | 'info' | 'error';
  title?: string;
  text: string;
}

function stripWrappedQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseFlagValue(
  args: string[],
  index: number,
  name: string,
): { value: string; nextIndex: number } | null {
  const arg = args[index] || '';
  if (arg === name) {
    const value = stripWrappedQuotes(String(args[index + 1] || ''));
    if (!value) {
      throw new Error(`Missing value for \`${name}\`.`);
    }
    return { value, nextIndex: index + 1 };
  }
  if (arg.startsWith(`${name}=`)) {
    const value = stripWrappedQuotes(arg.slice(`${name}=`.length));
    if (!value) {
      throw new Error(`Missing value for \`${name}\`.`);
    }
    return { value, nextIndex: index };
  }
  return null;
}

function parseCsvList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => stripWrappedQuotes(entry))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function matchesAgentFilter(
  rule: IndexedNetworkRule,
  agentFilter?: string,
): boolean {
  if (!agentFilter) return true;
  const normalized = agentFilter.trim().toLowerCase();
  if (!normalized) return true;
  return rule.agent === '*' || rule.agent === normalized;
}

function formatRuleAction(action: NetworkPolicyAction): string {
  return action.toUpperCase();
}

function formatRuleLine(rule: NetworkRule, index?: number): string {
  const prefix = typeof index === 'number' ? `[${index}] ` : '';
  const commentSuffix = rule.comment ? ` # ${rule.comment}` : '';
  return `${prefix}${formatRuleAction(rule.action)} ${rule.host}:${rule.port} ${rule.methods.join(',')} ${rule.paths.join(',')} (agent: ${rule.agent})${commentSuffix}`;
}

function collectHostScopeExpansionNotes(rules: NetworkRule[]): string[] {
  const expandingHosts = [
    ...new Set(
      rules
        .map((rule) => rule.host)
        .filter((host) => doesNetworkHostPatternExpandToSubdomains(host)),
    ),
  ];
  return expandingHosts.map(
    (host) =>
      `Note: ${host} also matches subdomains like *.${host} under current host-scope rules.`,
  );
}

function formatRuleTable(
  state: PolicyNetworkState,
  agentFilter?: string,
): string {
  const visibleRules = state.rules.filter((rule) =>
    matchesAgentFilter(rule, agentFilter),
  );
  const lines = [
    `Default: ${state.defaultAction}`,
    `Presets: ${state.presets.length > 0 ? state.presets.join(', ') : '(none)'}`,
  ];
  if (visibleRules.length === 0) {
    lines.push('(no matching rules)');
    return lines.join('\n');
  }

  const rows = visibleRules.map((rule) => ({
    index: String(rule.index),
    action: formatRuleAction(rule.action),
    host: rule.host,
    port: String(rule.port),
    methods: rule.methods.join(','),
    paths: rule.paths.join(','),
    agent: rule.agent,
    comment: rule.comment || '',
  }));
  const widths = {
    index: Math.max(1, ...rows.map((row) => row.index.length)),
    action: Math.max(6, ...rows.map((row) => row.action.length)),
    host: Math.max(4, ...rows.map((row) => row.host.length)),
    port: Math.max(4, ...rows.map((row) => row.port.length)),
    methods: Math.max(7, ...rows.map((row) => row.methods.length)),
    paths: Math.max(5, ...rows.map((row) => row.paths.length)),
    agent: Math.max(5, ...rows.map((row) => row.agent.length)),
  };
  lines.push(
    [
      '#'.padEnd(widths.index),
      'Action'.padEnd(widths.action),
      'Host'.padEnd(widths.host),
      'Port'.padEnd(widths.port),
      'Methods'.padEnd(widths.methods),
      'Paths'.padEnd(widths.paths),
      'Agent'.padEnd(widths.agent),
      'Comment',
    ].join('  '),
  );
  for (const row of rows) {
    lines.push(
      [
        row.index.padEnd(widths.index),
        row.action.padEnd(widths.action),
        row.host.padEnd(widths.host),
        row.port.padEnd(widths.port),
        row.methods.padEnd(widths.methods),
        row.paths.padEnd(widths.paths),
        row.agent.padEnd(widths.agent),
        row.comment,
      ].join('  '),
    );
  }
  return lines.join('\n');
}

function parseRuleCommand(
  action: NetworkPolicyAction,
  args: string[],
): NetworkRule {
  const host = stripWrappedQuotes(String(args[0] || ''));
  if (!host) {
    throw new Error(
      `Usage: \`policy ${action} <host> [--agent <id>] [--methods <list>] [--paths <list>] [--port <number|*>] [--comment <text>]\``,
    );
  }
  let agent = '*';
  let methods: string[] = ['*'];
  let paths: string[] = ['/**'];
  let port: number | '*' = '*';
  let comment = '';

  for (let index = 1; index < args.length; index += 1) {
    const agentFlag = parseFlagValue(args, index, '--agent');
    if (agentFlag) {
      agent = agentFlag.value;
      index = agentFlag.nextIndex;
      continue;
    }
    const methodsFlag = parseFlagValue(args, index, '--methods');
    if (methodsFlag) {
      methods = parseCsvList(methodsFlag.value);
      index = methodsFlag.nextIndex;
      continue;
    }
    const pathsFlag = parseFlagValue(args, index, '--paths');
    if (pathsFlag) {
      paths = parseCsvList(pathsFlag.value);
      index = pathsFlag.nextIndex;
      continue;
    }
    const portFlag = parseFlagValue(args, index, '--port');
    if (portFlag) {
      if (portFlag.value === '*') {
        port = '*';
        index = portFlag.nextIndex;
        continue;
      }
      if (!/^[0-9]+$/u.test(portFlag.value)) {
        throw new Error(
          '`--port` must be `*` or a base-10 integer in the range 1-65535.',
        );
      }
      const parsed = Number.parseInt(portFlag.value, 10);
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65_535) {
        throw new Error(
          '`--port` must be `*` or a base-10 integer in the range 1-65535.',
        );
      }
      port = parsed;
      index = portFlag.nextIndex;
      continue;
    }
    const commentFlag = parseFlagValue(args, index, '--comment');
    if (commentFlag) {
      comment = commentFlag.value;
      index = commentFlag.nextIndex;
      continue;
    }
    throw new Error(`Unknown flag: ${args[index]}`);
  }

  const normalized = normalizeNetworkRule({
    action,
    host,
    port,
    methods,
    paths,
    agent,
    ...(comment ? { comment } : {}),
  });
  if (!normalized) {
    throw new Error('Rule host is required.');
  }
  return normalized;
}

function buildListJson(
  state: PolicyNetworkState,
  agentFilter?: string,
): string {
  return JSON.stringify(
    {
      default: state.defaultAction,
      presets: state.presets,
      rules: state.rules
        .filter((rule) => matchesAgentFilter(rule, agentFilter))
        .map((rule) => ({
          index: rule.index,
          action: rule.action,
          host: rule.host,
          port: rule.port,
          methods: rule.methods,
          paths: rule.paths,
          agent: rule.agent,
          ...(rule.comment ? { comment: rule.comment } : {}),
          ...(rule.managedByPreset
            ? { managedByPreset: rule.managedByPreset }
            : {}),
        })),
    },
    null,
    2,
  );
}

function parseListFlags(args: string[]): {
  agent?: string;
  json: boolean;
} {
  let agent: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const agentFlag = parseFlagValue(args, index, '--agent');
    if (agentFlag) {
      agent = agentFlag.value;
      index = agentFlag.nextIndex;
      continue;
    }
    const arg = args[index] || '';
    if (arg === '--json') {
      json = true;
      continue;
    }
    throw new Error(`Unknown flag: ${arg}`);
  }
  return { agent, json };
}

export function runPolicyCommand(
  args: string[],
  params: {
    workspacePath: string;
  },
): PolicyCommandOutput {
  const subcommand = String(args[0] || 'status')
    .trim()
    .toLowerCase();
  const workspacePath = params.workspacePath;

  try {
    if (!subcommand || subcommand === 'status') {
      const state = readPolicyState(workspacePath);
      return {
        kind: 'info',
        title: 'Policy Status',
        text: [
          `Default: ${state.defaultAction}`,
          `Rules: ${state.rules.length}`,
          `Presets: ${state.presets.length > 0 ? state.presets.join(', ') : '(none)'}`,
        ].join('\n'),
      };
    }

    if (subcommand === 'list') {
      const flags = parseListFlags(args.slice(1));
      const state = readPolicyState(workspacePath);
      return {
        kind: 'info',
        title: 'Policy Rules',
        text: flags.json
          ? buildListJson(state, flags.agent)
          : formatRuleTable(state, flags.agent),
      };
    }

    if (subcommand === 'allow' || subcommand === 'deny') {
      const rule = parseRuleCommand(subcommand, args.slice(1));
      const state = addPolicyRule(workspacePath, rule);
      const added = state.rules[state.rules.length - 1];
      const notes = collectHostScopeExpansionNotes([added]);
      return {
        kind: 'plain',
        text: [
          `Rule added: ${formatRuleLine(added, added.index)}`,
          ...notes,
        ].join('\n'),
      };
    }

    if (subcommand === 'delete' || subcommand === 'remove') {
      const target = stripWrappedQuotes(String(args[1] || ''));
      if (!target) {
        throw new Error('Usage: `policy delete <number|host>`');
      }
      const { deleted } = deletePolicyRule(workspacePath, target);
      if (deleted.length === 1) {
        return {
          kind: 'plain',
          text: `Deleted rule #${deleted[0].index}: ${deleted[0].host} (agent: ${deleted[0].agent})`,
        };
      }
      return {
        kind: 'plain',
        text: `Deleted ${deleted.length} rules for ${target}.`,
      };
    }

    if (subcommand === 'reset') {
      const state = resetPolicyNetwork(workspacePath);
      return {
        kind: 'plain',
        text: `Policy reset. Default: ${state.defaultAction}. Rules: ${state.rules.length}.`,
      };
    }

    if (subcommand === 'default') {
      const nextDefault = String(args[1] || '')
        .trim()
        .toLowerCase();
      if (nextDefault !== 'allow' && nextDefault !== 'deny') {
        throw new Error('Usage: `policy default <allow|deny>`');
      }
      const state = setPolicyDefault(workspacePath, nextDefault);
      return {
        kind: 'plain',
        text: `Default policy: ${state.defaultAction}`,
      };
    }

    if (subcommand === 'preset') {
      const action = String(args[1] || 'list')
        .trim()
        .toLowerCase();
      if (!action || action === 'list') {
        const state = readPolicyState(workspacePath);
        const summaries = listPolicyPresetSummaries();
        return {
          kind: 'info',
          title: 'Policy Presets',
          text:
            summaries.length > 0
              ? summaries
                  .map(
                    (preset) =>
                      `${preset.name} — ${preset.description || '(no description)'}${state.presets.includes(preset.name) ? ' (applied)' : ''}`,
                  )
                  .join('\n')
              : '(none)',
        };
      }

      if (action === 'add') {
        const presetName = stripWrappedQuotes(String(args[2] || ''));
        if (!presetName) {
          throw new Error('Usage: `policy preset add <name> [--dry-run]`');
        }
        let dryRun = false;
        for (let index = 3; index < args.length; index += 1) {
          const arg = args[index] || '';
          if (arg === '--dry-run') {
            dryRun = true;
            continue;
          }
          throw new Error(`Unknown flag: ${arg}`);
        }
        const preview = previewPolicyPreset(workspacePath, presetName);
        if (dryRun) {
          const notes = collectHostScopeExpansionNotes(preview.addedRules);
          return {
            kind: 'info',
            title: 'Policy Preset Dry Run',
            text: [
              `Preset '${preview.preset.name}' would add:`,
              ...(preview.addedRules.length > 0
                ? preview.addedRules.map((rule) => `  ${formatRuleLine(rule)}`)
                : ['  (no new rules)']),
              ...notes,
            ].join('\n'),
          };
        }
        const applied = applyPolicyPreset(workspacePath, preview.preset.name);
        const notes = collectHostScopeExpansionNotes(applied.addedRules);
        return {
          kind: 'plain',
          text: [
            `Applied preset '${applied.preset.name}' (${applied.addedRules.length} rules added, ${applied.state.rules.length} total rules)`,
            ...notes,
          ].join('\n'),
        };
      }

      if (action === 'remove' || action === 'delete') {
        const presetName = stripWrappedQuotes(String(args[2] || ''));
        if (!presetName) {
          throw new Error('Usage: `policy preset remove <name>`');
        }
        const removed = removePolicyPreset(workspacePath, presetName);
        return {
          kind: 'plain',
          text: `Removed preset '${removed.preset.name}' (${removed.removedCount} rules removed)`,
        };
      }

      throw new Error(
        'Usage: `policy preset list`, `policy preset add <name> [--dry-run]`, or `policy preset remove <name>`',
      );
    }

    throw new Error(
      'Usage: `policy [status|list|allow|deny|delete|reset|preset|default] ...`',
    );
  } catch (error) {
    return {
      kind: 'error',
      title: 'Policy Command Failed',
      text: error instanceof Error ? error.message : String(error),
    };
  }
}
