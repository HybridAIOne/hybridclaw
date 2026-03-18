import type { PluginSummary } from './plugin-types.js';

function formatList(values: string[]): string {
  return values.length > 0 ? values.join(', ') : '(none)';
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
      lines.push(`  enabled: ${summary.enabled ? 'yes' : 'no'}`);
      if (summary.error) {
        lines.push(`  error: ${summary.error}`);
      }
      lines.push(`  tools: ${formatList(summary.tools)}`);
      lines.push(`  hooks: ${formatList(summary.hooks)}`);
      return lines.join('\n');
    })
    .join('\n\n');
}
