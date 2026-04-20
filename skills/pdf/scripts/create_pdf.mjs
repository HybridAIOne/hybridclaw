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
      const rawFontSize = argv[index + 1] || '';
      const parsed = Number.parseInt(rawFontSize, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        args.fontSize = parsed;
      } else {
        console.warn(
          `Ignoring invalid --font-size "${rawFontSize}" and keeping ${args.fontSize}.`,
        );
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
  const resolvedFont = fontMap[normalized];
  if (resolvedFont) {
    return resolvedFont;
  }
  console.warn(`Unknown --font "${name}". Falling back to Helvetica.`);
  return StandardFonts.Helvetica;
}

function normalizeTextBreaks(value) {
  return String(value || '')
    .replace(/\\n/g, '\n')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

function computeLineHeight(font, fontSize, multiplier) {
  return Math.max(
    font.heightAtSize(fontSize, { descender: true }) * multiplier,
    fontSize * multiplier,
  );
}

function splitLongToken(token, font, fontSize, maxWidth) {
  const pieces = [];
  let current = '';

  for (const character of token) {
    const next = `${current}${character}`;
    if (current && font.widthOfTextAtSize(next, fontSize) > maxWidth) {
      pieces.push(current);
      current = character;
      continue;
    }
    current = next;
  }

  if (current) {
    pieces.push(current);
  }

  return pieces;
}

// Wrap text ourselves so the vertical cursor tracks the actual rendered lines.
function buildWrappedLines(text, font, fontSize, maxWidth) {
  const wrappedLines = [];
  const normalizedText = normalizeTextBreaks(text);

  for (const rawLine of normalizedText.split('\n')) {
    if (!rawLine.trim()) {
      wrappedLines.push('');
      continue;
    }

    const words = rawLine.trim().split(/\s+/);
    let currentLine = '';

    for (const word of words) {
      const segments =
        font.widthOfTextAtSize(word, fontSize) > maxWidth
          ? splitLongToken(word, font, fontSize, maxWidth)
          : [word];

      for (const [segmentIndex, segment] of segments.entries()) {
        const joinsExistingWord = segmentIndex > 0;
        const candidate = currentLine
          ? joinsExistingWord
            ? `${currentLine}${segment}`
            : `${currentLine} ${segment}`
          : segment;
        if (font.widthOfTextAtSize(candidate, fontSize) <= maxWidth) {
          currentLine = candidate;
          continue;
        }

        if (currentLine) {
          wrappedLines.push(currentLine);
        }
        currentLine = segment;
      }
    }

    if (currentLine) {
      wrappedLines.push(currentLine);
    }
  }

  return wrappedLines;
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
  const firstPage = pdfDoc.addPage();
  const { width, height } = firstPage.getSize();
  const margin = 50;
  const maxWidth = width - margin * 2;
  let page = firstPage;
  let y = height - margin;

  // These helpers mutate the current page/cursor state in outer scope.
  const startNewPage = () => {
    page = pdfDoc.addPage([width, height]);
    y = height - margin;
  };

  const drawWrappedBlock = (lines, fontRef, fontSize, lineHeight) => {
    let drewText = false;
    for (const line of lines) {
      if (y - fontSize < margin) {
        startNewPage();
      }

      if (line) {
        page.drawText(line, {
          x: margin,
          y: y - fontSize,
          size: fontSize,
          font: fontRef,
          color: rgb(0, 0, 0),
        });
        drewText = true;
      }

      y -= lineHeight;
    }

    return drewText;
  };

  if (args.title) {
    const titleSize = Math.min(args.fontSize * 1.5, 48);
    const titleLineHeight = computeLineHeight(boldFont, titleSize, 1.15);
    const titleLines = buildWrappedLines(
      args.title,
      boldFont,
      titleSize,
      maxWidth,
    );
    if (drawWrappedBlock(titleLines, boldFont, titleSize, titleLineHeight)) {
      y -= Math.max(18, titleLineHeight * 0.45);
    }
  }

  if (args.text) {
    const bodyLineHeight = computeLineHeight(font, args.fontSize, 1.35);
    const bodyLines = buildWrappedLines(
      args.text,
      font,
      args.fontSize,
      maxWidth,
    );
    drawWrappedBlock(bodyLines, font, args.fontSize, bodyLineHeight);
  }

  fs.writeFileSync(args.outputPath, await pdfDoc.save());
  console.log(args.outputPath);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
