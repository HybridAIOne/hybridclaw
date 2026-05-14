import type { PluginAvailableSummary, PluginSummary } from './plugin-types.js';

function formatList(values: string[]): string {
  return values.length > 0 ? values.join(', ') : '(none)';
}

function formatCommands(values: string[]): string {
  return formatList(
    values.map((value) => (value.startsWith('/') ? value : `/${value}`)),
  );
}

export function formatPluginSummaryList(summaries: PluginSummary[]): string {
  if (summaries.length === 0) return 'No plugins discovered.';

  return summaries
    .map((summary) => {
      const header = [
        summary.id,
        ...(summary.version ? [`v${summary.version}`] : []),
        `[${summary.source}]`,
      ].join(' ');
      const lines = [header];
      if (summary.name && summary.name !== summary.id) {
        lines.push(`  name: ${summary.name}`);
      }
      if (summary.description) {
        lines.push(`  description: ${summary.description}`);
      }
      lines.push(`  enabled: ${summary.enabled ? 'yes' : 'no'}`);
      if (summary.error) {
        lines.push(`  error: ${summary.error}`);
      }
      lines.push(`  commands: ${formatCommands(summary.commands)}`);
      lines.push(`  tools: ${formatList(summary.tools)}`);
      lines.push(`  hooks: ${formatList(summary.hooks)}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

export function filterAvailablePluginSummaryList(
  available: PluginAvailableSummary[],
  installed: PluginSummary[],
): PluginAvailableSummary[] {
  const installedIds = new Set(installed.map((summary) => summary.id));
  return available.filter((summary) => !installedIds.has(summary.id));
}

export function formatAvailablePluginSummaryList(
  summaries: PluginAvailableSummary[],
): string {
  if (summaries.length === 0) return 'No installable plugins available.';

  return summaries
    .map((summary) => {
      const header = [
        summary.id,
        ...(summary.version ? [`v${summary.version}`] : []),
        `[${summary.source}]`,
      ].join(' ');
      const lines = [header];
      if (summary.name && summary.name !== summary.id) {
        lines.push(`  name: ${summary.name}`);
      }
      if (summary.description) {
        lines.push(`  description: ${summary.description}`);
      }
      lines.push(`  install: /plugin install ${summary.installSource}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

export function formatPluginCatalogList(params: {
  installed: PluginSummary[];
  available: PluginAvailableSummary[];
}): string {
  return [
    'Installed',
    formatPluginSummaryList(params.installed),
    '',
    'Available',
    formatAvailablePluginSummaryList(
      filterAvailablePluginSummaryList(params.available, params.installed),
    ),
  ].join('\n');
}
