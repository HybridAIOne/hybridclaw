import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const { createCanvas } = createRequire(
  new URL('../../container/package.json', import.meta.url),
)('@napi-rs/canvas');
import { PDFDocument } from 'pdf-lib';

/** The figure's colors and shapes exist only in pixels, never extracted text. */
export async function writeVisualPdfFixture(root: string) {
  const canvas = createCanvas(600, 200);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, 600, 200);
  ctx.fillStyle = 'red';
  ctx.beginPath();
  ctx.arc(100, 100, 55, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'blue';
  ctx.fillRect(250, 50, 100, 100);
  ctx.fillStyle = 'green';
  ctx.beginPath();
  ctx.moveTo(500, 35);
  ctx.lineTo(560, 155);
  ctx.lineTo(440, 155);
  ctx.closePath();
  ctx.fill();
  const image = await canvas.encode('png');
  await fs.writeFile(path.join(root, 'figure.png'), image);
  const pdf = await PDFDocument.create();
  const embedded = await pdf.embedPng(image);
  for (let n = 1; n <= 7; n++) {
    const page = pdf.addPage([600, 400]);
    page.drawText(`Workshop guide, page ${n}`, { x: 30, y: 360, size: 18 });
    if (n === 7) {
      page.drawImage(embedded, { x: 0, y: 100, width: 600, height: 200 });
      page.drawText('Figure 3. A sequence of symbols.', {
        x: 30,
        y: 60,
        size: 15,
      });
    } else
      page.drawText(
        'Five ideas: Plan the task. Gather evidence. Compare options.\nCheck the result. Explain your conclusion.',
        { x: 30, y: 290, size: 14 },
      );
  }
  await fs.writeFile(path.join(root, 'workshop.pdf'), await pdf.save());
  await fs.symlink(path.resolve('skills'), path.join(root, 'skills'));
}
