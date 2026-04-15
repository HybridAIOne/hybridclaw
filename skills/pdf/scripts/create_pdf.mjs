#!/usr/bin/env node

import fs from 'node:fs';
import process from 'node:process';

import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

function parseArgs(argv) {
  const args = {
    outputPath: '',
    text: '',
    title: '',
    fontSize: 24,
    fontName: 'Helvetica',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value) continue;
    if (value === '--text') {
      args.text = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (value === '--title') {
      args.title = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (value === '--font-size') {
      const parsed = Number.parseInt(argv[index + 1] || '', 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        args.fontSize = parsed;
      }
      index += 1;
      continue;
    }
    if (value === '--font') {
      args.fontName = argv[index + 1] || 'Helvetica';
      index += 1;
      continue;
    }
    if (!args.outputPath) {
      args.outputPath = value;
    }
  }

  return args;
}

function resolveStandardFont(name) {
  const normalized = name.toLowerCase().replace(/[^a-z]/g, '');
  const fontMap = {
    helvetica: StandardFonts.Helvetica,
    helveticabold: StandardFonts.HelveticaBold,
    helveticaoblique: StandardFonts.HelveticaOblique,
    helveticaboldoblique: StandardFonts.HelveticaBoldOblique,
    courier: StandardFonts.Courier,
    courierbold: StandardFonts.CourierBold,
    courieroblique: StandardFonts.CourierOblique,
    courierboldoblique: StandardFonts.CourierBoldOblique,
    timesroman: StandardFonts.TimesRoman,
    timesbold: StandardFonts.TimesRomanBold,
    timesitalic: StandardFonts.TimesRomanItalic,
    timesbolditalic: StandardFonts.TimesRomanBoldItalic,
  };
  return fontMap[normalized] || StandardFonts.Helvetica;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.outputPath || (!args.text && !args.title)) {
    console.error(
      'Usage: node skills/pdf/scripts/create_pdf.mjs <output.pdf> --text "content" [--title "heading"] [--font-size 24] [--font Helvetica]',
    );
    process.exitCode = 1;
    return;
  }

  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(resolveStandardFont(args.fontName));
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const page = pdfDoc.addPage();
  const { width, height } = page.getSize();
  const margin = 50;
  let y = height - margin;

  if (args.title) {
    const titleSize = Math.min(args.fontSize * 1.5, 48);
    page.drawText(args.title, {
      x: margin,
      y: y - titleSize,
      size: titleSize,
      font: boldFont,
      color: rgb(0, 0, 0),
      maxWidth: width - margin * 2,
    });
    y -= titleSize + 30;
  }

  if (args.text) {
    const lines = args.text.split('\\n');
    const lineHeight = args.fontSize * 1.4;
    for (const line of lines) {
      if (y - args.fontSize < margin) {
        break;
      }
      page.drawText(line, {
        x: margin,
        y: y - args.fontSize,
        size: args.fontSize,
        font,
        color: rgb(0, 0, 0),
        maxWidth: width - margin * 2,
      });
      y -= lineHeight;
    }
  }

  fs.writeFileSync(args.outputPath, await pdfDoc.save());
  console.log(args.outputPath);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
