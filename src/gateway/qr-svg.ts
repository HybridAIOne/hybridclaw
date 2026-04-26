import { createRequire } from 'node:module';

interface QRCodeInstance {
  addData(input: string): void;
  make(): void;
  getModuleCount(): number;
  isDark(row: number, col: number): boolean;
}

type QRCodeConstructor = new (
  typeNumber: number,
  errorCorrectionLevel: number,
) => QRCodeInstance;

const require = createRequire(import.meta.url);
const QRCode = require('qrcode-terminal/vendor/QRCode') as QRCodeConstructor;
const QRErrorCorrectLevel =
  require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel') as { M: number };

export function renderQrSvg(input: string): string {
  const qr = new QRCode(-1, QRErrorCorrectLevel.M);
  qr.addData(input);
  qr.make();

  const moduleCount = qr.getModuleCount();
  const quietZone = 4;
  const cellSize = 8;
  const size = (moduleCount + quietZone * 2) * cellSize;
  const rects: string[] = [];

  for (let row = 0; row < moduleCount; row += 1) {
    for (let col = 0; col < moduleCount; col += 1) {
      if (!qr.isDark(row, col)) continue;
      rects.push(
        `<rect x="${(col + quietZone) * cellSize}" y="${(row + quietZone) * cellSize}" width="${cellSize}" height="${cellSize}"/>`,
      );
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="Mobile session QR code">`,
    '<rect width="100%" height="100%" fill="#fff"/>',
    '<g fill="#111827">',
    rects.join(''),
    '</g>',
    '</svg>',
  ].join('');
}
