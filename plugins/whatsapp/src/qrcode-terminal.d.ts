declare module 'qrcode-terminal' {
  interface QRCodeOptions {
    small?: boolean;
  }

  interface QRCodeTerminal {
    generate(
      input: string,
      options?: QRCodeOptions,
      callback?: (output: string) => void,
    ): void;
  }

  const qrcode: QRCodeTerminal;
  export default qrcode;
}
