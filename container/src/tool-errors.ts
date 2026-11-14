/**
 * Tool failures retain their model-visible output across implementation modules.
 * Unlike approval denials, this carries no permission or retry decision.
 */
export class ToolExecutionFailure extends Error {
  readonly output: string;

  constructor(output: string) {
    super(output);
    this.name = 'ToolExecutionFailure';
    this.output = output;
  }
}

export function failTool(output: string): never {
  throw new ToolExecutionFailure(output);
}
