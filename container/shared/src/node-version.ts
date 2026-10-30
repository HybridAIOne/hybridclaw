/**
 * Node compatibility checks are dependency-free so bootstrap can reject unsafe
 * runtimes before loading application code. Package manifests own the range;
 * this module only supports the bounded stable-release range used by HybridClaw.
 */
export interface NodeVersionCheck {
  ok: boolean;
  message?: string;
}

export function parseNodeRange(range: string): {
  minimum: string;
  major: number;
} {
  const match = /^>=(\d+)\.(\d+)\.(\d+) <(\d+)$/.exec(range);
  if (!match || Number(match[4]) !== Number(match[1]) + 1) {
    throw new Error(`Unsupported Node.js engines range: "${range}".`);
  }
  return {
    minimum: `${match[1]}.${match[2]}.${match[3]}`,
    major: Number(match[1]),
  };
}

export function checkNodeVersion(
  nodeVersion: string,
  requiredRange: string,
): NodeVersionCheck {
  const { minimum, major } = parseNodeRange(requiredRange);
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(
    nodeVersion,
  );
  const actual = match ? match.slice(1).map(Number) : [];
  const floor = minimum.split('.').map(Number);
  const ok =
    actual[0] === major &&
    (actual[1] > floor[1] || (actual[1] === floor[1] && actual[2] >= floor[2]));
  return {
    ok,
    ...(ok
      ? {}
      : {
          message: `HybridClaw requires Node.js ${requiredRange}, but this process is running ${nodeVersion}.\nInstall a supported Node.js release and run the command again.`,
        }),
  };
}
