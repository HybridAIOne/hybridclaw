import fs from 'node:fs';
import path from 'node:path';

export interface BehaviorTrajectoryTool {
  name: string;
  args: Record<string, unknown>;
}

// Writes `count` approved skill-run trajectories in the R10.1 store layout the
// behavior anomaly reranker trains on: `<storeDir>/<date>/<agent>.jsonl`.
export function writeBehaviorTrajectoryStore(params: {
  storeDir: string;
  agentId: string;
  count: number;
  tools?: BehaviorTrajectoryTool[];
  date?: string;
  fileName?: string;
  append?: boolean;
}): string {
  const date = params.date || '2026-05-01';
  const dir = path.join(params.storeDir, date);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, params.fileName || `${params.agentId}.jsonl`);
  const tools = params.tools || [
    { name: 'read', args: { path: '/workspace/docs/readme.md' } },
  ];
  const lines = Array.from({ length: params.count }, (_, index) =>
    JSON.stringify({
      schema_version: 2,
      captured_at: `${date}T10:${String(index % 60).padStart(2, '0')}:00.000Z`,
      agent_id: params.agentId,
      outcome: 'success',
      tools_used: tools.map((tool) => ({
        name: tool.name,
        duration_ms: 1,
        is_error: false,
        blocked: false,
        approval_tier: 'green',
        approval_decision: 'auto',
        arguments: {
          content: JSON.stringify(tool.args),
          truncated: false,
          source: 'full',
        },
        result: {
          content: 'ok',
          truncated: false,
          source: 'full',
        },
      })),
    }),
  );
  const write = params.append ? fs.appendFileSync : fs.writeFileSync;
  write(filePath, `${lines.join('\n')}\n`, 'utf-8');
  return filePath;
}
