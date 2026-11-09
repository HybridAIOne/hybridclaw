export interface NodeVersionCheck {
  ok: boolean;
  message?: string;
}
export declare function parseNodeRange(range: string): {
  minimum: string;
  major: number;
};
export declare function checkNodeVersion(
  nodeVersion: string,
  requiredRange: string,
): NodeVersionCheck;
