#!/usr/bin/env node

import fs from 'node:fs';
import process from 'node:process';

import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

const MAX_IMAGE_BYTES = 5_000_000;

function parseArgs(argv) {
  const args = {
    outputPath: '',
    text: '',
    title: '',
    fontSize: 24,
    fontName: 'Helvetica',
    fontPath: '',
    imagePath: '',
    imageUrl: '',
    imageMaxWidth: 220,
    imageMaxHeight: 160,
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
    if (value === '--font-path') {
      args.fontPath = argv[index + 1] || '';
      if (!args.fontPath)
        throw new Error('--font-path requires a TTF/OTF path.');
      index += 1;
      continue;
    }
    if (value === '--font') {
      args.fontName = argv[index + 1] || 'Helvetica';
      index += 1;
      continue;
    }
    if (value === '--image-path') {
      args.imagePath = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (value === '--image-url') {
      args.imageUrl = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (value === '--image-max-width') {
      args.imageMaxWidth = parsePositiveInteger(
        argv[index + 1] || '',
        '--image-max-width',
        args.imageMaxWidth,
      );
      index += 1;
      continue;
    }
    if (value === '--image-max-height') {
      args.imageMaxHeight = parsePositiveInteger(
        argv[index + 1] || '',
        '--image-max-height',
        args.imageMaxHeight,
      );
      index += 1;
      continue;
    }
    if (!args.outputPath) {
      args.outputPath = value;
    }
  }

  return args;
}

function parsePositiveInteger(value, label, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  console.warn(`Ignoring invalid ${label} "${value}" and keeping ${fallback}.`);
  return fallback;
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

async function embedTextFont(
  pdfDoc,
  fields,
  standardName,
  fontPath,
  bundledName,
) {
  const characters = Object.entries(fields).map(([field, text]) => [
    field,
    [...new Set(normalizeTextBreaks(text).replace(/\s/g, ''))],
  ]);
  if (characters.every(([, values]) => values.length === 0)) return null;
  if (!fontPath) {
    const standard = await pdfDoc.embedFont(standardName);
    const supported = new Set(standard.getCharacterSet());
    if (
      characters.every(([, values]) =>
        values.every((character) => supported.has(character.codePointAt(0))),
      )
    ) {
      return standard;
    }
  }

  const { default: fontkit } = await import('@pdf-lib/fontkit');
  const source =
    fontPath ||
    new URL(
      import.meta.resolve(
        `pdfjs-dist/standard_fonts/LiberationSans-${bundledName}.ttf`,
      ),
    );
  const bytes = fs.readFileSync(source);
  const parsed = fontkit.create(bytes);
  for (const [field, values] of characters) {
    const missing = values.find(
      (character) => !parsed.hasGlyphForCodePoint(character.codePointAt(0)),
    );
    if (!missing) continue;
    const code = missing
      .codePointAt(0)
      .toString(16)
      .toUpperCase()
      .padStart(4, '0');
    const guidance = fontPath
      ? `The supplied --font-path "${fontPath}" lacks this glyph; choose a font covering the requested text. `
      : 'Use --font-path with a TTF/OTF font covering the requested text. ';
    throw new Error(
      `PDF font cannot encode "${missing}" (U+${code}) in --${field}. ` +
        guidance +
        'Keep the original characters; do not replace them with transliterations.',
    );
  }
  pdfDoc.registerFontkit(fontkit);
  return pdfDoc.embedFont(bytes, { subset: true });
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

function inferImageType(bytes, source) {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return 'jpg';
  }
  throw new Error(`${source} must be a PNG or JPEG image.`);
}

async function readImageBytes(args) {
  if (args.imagePath && args.imageUrl) {
    throw new Error('Use either --image-path or --image-url, not both.');
  }
  if (args.imagePath) {
    const bytes = fs.readFileSync(args.imagePath);
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new Error('--image-path image is too large.');
    }
    return { bytes, source: args.imagePath };
  }
  if (!args.imageUrl) return null;

  const parsed = new URL(args.imageUrl);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('--image-url must use http or https.');
  }
  const response = await fetch(parsed);
  if (!response.ok) {
    throw new Error(`Failed to fetch --image-url: HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error('--image-url image is too large.');
  }
  return { bytes, source: args.imageUrl };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (
    !args.outputPath ||
    (!args.text && !args.title && !args.imagePath && !args.imageUrl)
  ) {
    console.error(
      'Usage: node skills/pdf/scripts/create_pdf.mjs <output.pdf> --text "content" [--title "heading"] [--image-url https://example.com/logo.png] [--image-path logo.png] [--font-size 24] [--font Helvetica] [--font-path font.ttf]',
    );
    process.exitCode = 1;
    return;
  }

  const pdfDoc = await PDFDocument.create();
  const font = await embedTextFont(
    pdfDoc,
    args.fontPath
      ? { text: args.text, title: args.title }
      : { text: args.text },
    resolveStandardFont(args.fontName),
    args.fontPath,
    'Regular',
  );
  const boldFont = args.fontPath
    ? font
    : await embedTextFont(
        pdfDoc,
        { title: args.title },
        StandardFonts.HelveticaBold,
        args.fontPath,
        'Bold',
      );
  const imageInput = await readImageBytes(args);
  let embeddedImage = null;
  if (imageInput) {
    const imageType = inferImageType(imageInput.bytes, imageInput.source);
    embeddedImage =
      imageType === 'png'
        ? await pdfDoc.embedPng(imageInput.bytes)
        : await pdfDoc.embedJpg(imageInput.bytes);
  }
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

  if (boldFont && args.title.trim()) {
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

  if (embeddedImage) {
    const imageScale = Math.min(
      args.imageMaxWidth / embeddedImage.width,
      args.imageMaxHeight / embeddedImage.height,
      1,
    );
    const imageWidth = embeddedImage.width * imageScale;
    const imageHeight = embeddedImage.height * imageScale;
    if (y - imageHeight < margin) {
      startNewPage();
    }
    page.drawImage(embeddedImage, {
      x: margin,
      y: y - imageHeight,
      width: imageWidth,
      height: imageHeight,
    });
    y -= imageHeight + Math.max(18, args.fontSize * 0.75);
  }

  if (font && args.text.trim()) {
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
