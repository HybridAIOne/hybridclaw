export interface BuiltinTool {
  readonly name: string;
  readonly group: string;
  /** May overlap any other call in a batch; see container tool-parallelism. */
  readonly parallelSafe?: true;
}

export declare const BUILTIN_TOOLS: readonly BuiltinTool[];
