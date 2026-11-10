/**
 * Gateway reports aggregate the worker's shared usage snapshot shape.
 * Unlike provider accounting, these types group stored counters; they do not
 * normalize provider responses or estimate missing charges.
 */
export type {
  ModelCallPerformanceSample,
  ModelCallTiming,
  TokenUsageStats,
} from '@hybridclaw/shared/token-usage';

export type UsageWindow = 'daily' | 'monthly' | 'all';

export interface UsageTotals {
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_write_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  cost_per_call_usd: number;
  call_count: number;
  total_tool_calls: number;
  billable_units?: UsageBillableUnitTotal[];
}

export interface UsageBillableUnitTotal {
  unit: string;
  quantity: number;
  cost_usd: number;
}

export interface UsageModelAggregate {
  model: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_write_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  call_count: number;
  total_tool_calls: number;
}

export interface UsageAgentAggregate {
  agent_id: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_write_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  call_count: number;
  total_tool_calls: number;
}

export interface UsageAgentRollup extends UsageAgentAggregate {
  monthly_cost_usd: number;
}

export interface UsageSessionAggregate {
  session_id: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_write_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  call_count: number;
  total_tool_calls: number;
}

export interface UsageDailyAggregate {
  day: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_write_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  call_count: number;
  total_tool_calls: number;
}
