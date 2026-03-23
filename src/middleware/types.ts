import type {
  MiddlewarePhase as SharedMiddlewarePhase,
  ResultMiddlewarePhase as SharedResultMiddlewarePhase,
  ToolDecision as SharedToolDecision,
} from '../../container/shared/middleware-types.js';
import type { RuntimeConfig } from '../config/runtime-config.js';
import type { ChatMessage } from '../types.js';

export type MiddlewarePhase = SharedMiddlewarePhase;
export type ResultMiddlewarePhase = SharedResultMiddlewarePhase;
export type ToolDecision = SharedToolDecision;

export interface MiddlewareSessionState {
  [key: string]: unknown;
}

export interface MiddlewareContext<
  TState extends MiddlewareSessionState = MiddlewareSessionState,
> {
  config: RuntimeConfig;
  state: TState;
  messages: ChatMessage[];
}

export interface ToolMiddlewareContext<
  TState extends MiddlewareSessionState = MiddlewareSessionState,
> extends MiddlewareContext<TState> {
  toolName: string;
  toolArgs: Record<string, unknown>;
  toolResult?: string;
}

export interface MiddlewareResult<
  TState extends MiddlewareSessionState = MiddlewareSessionState,
> {
  stateUpdates?: Partial<TState>;
  messages?: ChatMessage[];
  halt?: boolean;
}

export interface Middleware<
  TState extends MiddlewareSessionState = MiddlewareSessionState,
  TContext extends MiddlewareContext<TState> = MiddlewareContext<TState>,
  TToolContext extends
    ToolMiddlewareContext<TState> = ToolMiddlewareContext<TState>,
> {
  name: string;
  isEnabled(config: RuntimeConfig): boolean;
  timeoutsMs?: Partial<Record<MiddlewarePhase, number>>;
  beforeAgent?: (ctx: TContext) => Promise<MiddlewareResult<TState>>;
  beforeModel?: (ctx: TContext) => Promise<MiddlewareResult<TState>>;
  afterModel?: (ctx: TContext) => Promise<MiddlewareResult<TState>>;
  beforeTool?: (ctx: TToolContext) => Promise<ToolDecision>;
  afterTool?: (ctx: TToolContext) => Promise<MiddlewareResult<TState>>;
  afterAgent?: (ctx: TContext) => Promise<MiddlewareResult<TState>>;
}
