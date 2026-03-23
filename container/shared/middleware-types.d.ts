export type MiddlewarePhase =
  | 'beforeAgent'
  | 'beforeModel'
  | 'afterModel'
  | 'beforeTool'
  | 'afterTool'
  | 'afterAgent';

export type ToolDecision =
  | { action: 'continue' }
  | { action: 'modify'; args: Record<string, unknown> }
  | { action: 'deny'; reason: string }
  | { action: 'abort-turn'; reason: string };
