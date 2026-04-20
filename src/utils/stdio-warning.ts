function isAcpStdioProtocol(): boolean {
  return (
    String(process.env.HYBRIDCLAW_STDIO_PROTOCOL || '')
      .trim()
      .toLowerCase() === 'acp'
  );
}

export function emitRuntimeWarning(message: string): void {
  if (isAcpStdioProtocol()) {
    process.stderr.write(`${message}\n`);
    return;
  }
  console.warn(message);
}
