export type ResultMiddlewarePhase =
  | 'beforeAgent'
  | 'beforeModel'
  | 'afterModel'
  | 'afterTool'
  | 'afterAgent';

export type MiddlewarePhase = ResultMiddlewarePhase | 'beforeTool';

export type ToolDecision =
  | { action: 'continue' }
  | { action: 'modify'; args: Record<string, unknown> }
  | { action: 'deny'; reason: string }
  | { action: 'abort-turn'; reason: string };
