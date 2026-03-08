import fs from 'node:fs/promises';

import {
  PDFButton,
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFSignature,
  PDFTextField,
  rgb,
  StandardFonts,
} from 'pdf-lib';

const COLOR_PATTERN = /^#?([0-9a-f]{6})$/i;
const FONT_ALIASES = new Map([
  ['courier', StandardFonts.Courier],
  ['courier-bold', StandardFonts.CourierBold],
  ['courier-oblique', StandardFonts.CourierOblique],
  ['courier-boldoblique', StandardFonts.CourierBoldOblique],
  ['helvetica', StandardFonts.Helvetica],
  ['helvetica-bold', StandardFonts.HelveticaBold],
  ['helvetica-oblique', StandardFonts.HelveticaOblique],
  ['helvetica-boldoblique', StandardFonts.HelveticaBoldOblique],
  ['times-roman', StandardFonts.TimesRoman],
  ['times-bold', StandardFonts.TimesBold],
  ['times-italic', StandardFonts.TimesItalic],
  ['times-bolditalic', StandardFonts.TimesBoldItalic],
]);

function roundCoord(value) {
  return Math.round(Number(value) * 10) / 10;
}

function asString(value) {
  if (value == null) return '';
  return String(value);
}

function slashName(value) {
  const normalized = asString(value).trim();
  if (!normalized) return '';
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

function stripSlash(value) {
  const normalized = asString(value).trim();
  return normalized.startsWith('/') ? normalized.slice(1) : normalized;
}

function widgetRectToPdfArray(widget) {
  const rect = widget.getRectangle();
  return [
    roundCoord(rect.x),
    roundCoord(rect.y),
    roundCoord(rect.x + rect.width),
    roundCoord(rect.y + rect.height),
  ];
}

function widgetRectToTopOriginArray(widget, pageHeight) {
  const rect = widget.getRectangle();
  return [
    roundCoord(rect.x),
    roundCoord(pageHeight - (rect.y + rect.height)),
    roundCoord(rect.x + rect.width),
    roundCoord(pageHeight - rect.y),
  ];
}

function pageLookup(pdfDoc) {
  return new Map(
    pdfDoc.getPages().map((page, index) => [
      page.ref.toString(),
      {
        pageNumber: index + 1,
        width: page.getWidth(),
        height: page.getHeight(),
      },
    ]),
  );
}

function pageInfoForWidget(widget, pagesByRef, defaultPageInfo) {
  const pageRef = widget.P();
  if (pageRef) {
    const resolved = pagesByRef.get(pageRef.toString());
    if (resolved) return resolved;
  }
  return defaultPageInfo || null;
}

function sortFields(left, right) {
  const leftRect = Array.isArray(left.rect)
    ? left.rect
    : left.radio_options?.[0]?.rect || left.widgets?.[0]?.rect || [0, 0, 0, 0];
  const rightRect = Array.isArray(right.rect)
    ? right.rect
    : right.radio_options?.[0]?.rect ||
      right.widgets?.[0]?.rect || [0, 0, 0, 0];

  if ((left.page || 0) !== (right.page || 0)) {
    return (left.page || 0) - (right.page || 0);
  }
  if (leftRect[3] !== rightRect[3]) {
    return rightRect[3] - leftRect[3];
  }
  return leftRect[0] - rightRect[0];
}

function fieldType(field) {
  if (field instanceof PDFTextField) return 'text';
  if (field instanceof PDFCheckBox) return 'checkbox';
  if (field instanceof PDFRadioGroup) return 'radio_group';
  if (field instanceof PDFDropdown || field instanceof PDFOptionList)
    return 'choice';
  if (field instanceof PDFButton) return 'button';
  if (field instanceof PDFSignature) return 'signature';
  return 'unknown';
}

function radioOptionValues(field, widgets) {
  const options = field.getOptions?.() || [];
  const exportValues =
    field.acroField.getExportValues?.().map((value) => value.decodeText()) ||
    [];

  return widgets.map((widget, index) => {
    const widgetValue = widget.getOnValue?.()?.decodeText?.();
    return asString(
      exportValues[index] || options[index] || widgetValue || index,
    );
  });
}

function checkboxValues(field) {
  return {
    checkedValue: slashName(
      field.acroField.getOnValue?.()?.decodeText?.() || 'Yes',
    ),
    uncheckedValue: '/Off',
  };
}

function choiceOptions(field) {
  const options = field.getOptions?.() || [];
  return options.map((option) => ({
    value: asString(option),
    text: asString(option),
  }));
}

function multiWidgetEntries(widgets, pagesByRef, defaultPageInfo) {
  return widgets.map((widget) => {
    const pageInfo = pageInfoForWidget(widget, pagesByRef, defaultPageInfo);
    return {
      page: pageInfo?.pageNumber,
      rect: widgetRectToPdfArray(widget),
      top_origin_rect: pageInfo
        ? widgetRectToTopOriginArray(widget, pageInfo.height)
        : undefined,
    };
  });
}

export async function loadPdfDocument(inputPath) {
  const bytes = await fs.readFile(inputPath);
  return PDFDocument.load(bytes);
}

export async function hasFillableFields(inputPath) {
  const pdfDoc = await loadPdfDocument(inputPath);
  return pdfDoc.getForm().getFields().length > 0;
}

export async function extractFormFieldInfo(inputPath) {
  const pdfDoc = await loadPdfDocument(inputPath);
  return extractFormFieldInfoFromDocument(pdfDoc);
}

export function extractFormFieldInfoFromDocument(pdfDoc) {
  const form = pdfDoc.getForm();
  const pagesByRef = pageLookup(pdfDoc);
  const defaultPageInfo = pdfDoc.getPages().length
    ? {
        pageNumber: 1,
        width: pdfDoc.getPages()[0].getWidth(),
        height: pdfDoc.getPages()[0].getHeight(),
      }
    : null;

  const fields = [];

  for (const field of form.getFields()) {
    const widgets = field.acroField.getWidgets();
    const type = fieldType(field);
    const firstPageInfo =
      widgets.length > 0
        ? pageInfoForWidget(widgets[0], pagesByRef, defaultPageInfo)
        : defaultPageInfo;

    if (type === 'button' || type === 'signature' || type === 'unknown') {
      fields.push({
        field_id: field.getName(),
        page: firstPageInfo?.pageNumber,
        type,
        rect: widgets[0] ? widgetRectToPdfArray(widgets[0]) : undefined,
      });
      continue;
    }

    if (type === 'radio_group') {
      const optionValues = radioOptionValues(field, widgets);
      fields.push({
        field_id: field.getName(),
        page: firstPageInfo?.pageNumber,
        type,
        radio_options: widgets.map((widget, index) => {
          const pageInfo = pageInfoForWidget(widget, pagesByRef, firstPageInfo);
          return {
            value: optionValues[index],
            page: pageInfo?.pageNumber,
            rect: widgetRectToPdfArray(widget),
            top_origin_rect: pageInfo
              ? widgetRectToTopOriginArray(widget, pageInfo.height)
              : undefined,
          };
        }),
      });
      continue;
    }

    const entry = {
      field_id: field.getName(),
      page: firstPageInfo?.pageNumber,
      type,
      rect: widgets[0] ? widgetRectToPdfArray(widgets[0]) : undefined,
    };

    if (widgets.length > 1) {
      entry.widgets = multiWidgetEntries(widgets, pagesByRef, firstPageInfo);
    }

    if (type === 'checkbox') {
      const { checkedValue, uncheckedValue } = checkboxValues(field);
      entry.checked_value = checkedValue;
      entry.unchecked_value = uncheckedValue;
    }

    if (type === 'choice') {
      entry.choice_options = choiceOptions(field);
    }

    fields.push(entry);
  }

  fields.sort(sortFields);
  return fields;
}

function normalizeCheckboxSelection(fieldInfo, rawValue) {
  if (rawValue === true) return true;
  if (rawValue === false) return false;
  const checkedValue = stripSlash(fieldInfo.checked_value);
  const uncheckedValue = stripSlash(fieldInfo.unchecked_value || '/Off');
  const normalized = stripSlash(rawValue);
  if (!normalized) return null;
  if (normalized === checkedValue) return true;
  if (normalized === uncheckedValue) return false;
  return null;
}

export function validateRequestedFieldValue(fieldInfo, fieldValue) {
  if (fieldValue == null) return null;

  if (fieldInfo.type === 'checkbox') {
    const normalized = normalizeCheckboxSelection(fieldInfo, fieldValue);
    if (normalized == null) {
      return (
        `ERROR: Invalid value "${fieldValue}" for checkbox field "${fieldInfo.field_id}". ` +
        `Use ${fieldInfo.checked_value} or ${fieldInfo.unchecked_value} (or true/false).`
      );
    }
    return null;
  }

  if (fieldInfo.type === 'radio_group') {
    const validOptions = fieldInfo.radio_options.map((option) => option.value);
    if (!validOptions.includes(asString(fieldValue))) {
      return (
        `ERROR: Invalid value "${fieldValue}" for radio group field "${fieldInfo.field_id}". ` +
        `Valid values are: ${JSON.stringify(validOptions)}`
      );
    }
    return null;
  }

  if (fieldInfo.type === 'choice') {
    const validOptions = fieldInfo.choice_options.map((option) => option.value);
    const requestedValues = Array.isArray(fieldValue)
      ? fieldValue.map(asString)
      : [asString(fieldValue)];
    const invalid = requestedValues.filter(
      (value) => !validOptions.includes(value),
    );
    if (invalid.length > 0) {
      return (
        `ERROR: Invalid value(s) ${JSON.stringify(invalid)} for choice field "${fieldInfo.field_id}". ` +
        `Valid values are: ${JSON.stringify(validOptions)}`
      );
    }
  }

  return null;
}

function applyFieldValue(field, fieldInfo, rawValue) {
  if (rawValue == null) return;

  if (field instanceof PDFTextField) {
    field.setText(asString(rawValue));
    return;
  }

  if (field instanceof PDFCheckBox) {
    const checked = normalizeCheckboxSelection(fieldInfo, rawValue);
    if (checked) field.check();
    else field.uncheck();
    return;
  }

  if (field instanceof PDFRadioGroup) {
    field.select(asString(rawValue));
    return;
  }

  if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
    const values = Array.isArray(rawValue)
      ? rawValue.map(asString)
      : asString(rawValue);
    field.select(values);
  }
}

export async function fillFillableFields(
  inputPath,
  fieldValues,
  outputPath,
  options = {},
) {
  const { flatten = false } = options;
  const pdfDoc = await loadPdfDocument(inputPath);
  const form = pdfDoc.getForm();
  const fieldInfo = extractFormFieldInfoFromDocument(pdfDoc);
  const fieldInfoById = new Map(
    fieldInfo.map((entry) => [entry.field_id, entry]),
  );
  const pdfFieldsById = new Map(
    form.getFields().map((field) => [field.getName(), field]),
  );
  const errors = [];
  let updatedCount = 0;

  for (const field of fieldValues) {
    if (!field || !('field_id' in field) || !('value' in field)) continue;
    const fieldId = asString(field.field_id);
    const existing = fieldInfoById.get(fieldId);
    if (!existing) {
      errors.push(`ERROR: "${fieldId}" is not a valid field ID`);
      continue;
    }

    if (field.page != null && Number(field.page) !== Number(existing.page)) {
      errors.push(
        `ERROR: Incorrect page number for "${fieldId}" (got ${field.page}, expected ${existing.page})`,
      );
      continue;
    }

    const validationError = validateRequestedFieldValue(existing, field.value);
    if (validationError) {
      errors.push(validationError);
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }

  for (const field of fieldValues) {
    if (!field || !('field_id' in field) || !('value' in field)) continue;
    const target = pdfFieldsById.get(asString(field.field_id));
    const metadata = fieldInfoById.get(asString(field.field_id));
    if (!target || !metadata) continue;
    applyFieldValue(target, metadata, field.value);
    updatedCount += 1;
  }

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  form.updateFieldAppearances(font);
  if (flatten) form.flatten({ updateFieldAppearances: false });

  const outputBytes = await pdfDoc.save();
  await fs.writeFile(outputPath, outputBytes);

  return { outputPath, updatedCount };
}

export function loadJsonShape(rawValue) {
  if (Array.isArray(rawValue)) return rawValue;
  if (rawValue && typeof rawValue === 'object') return rawValue;
  throw new Error('Expected JSON object or array');
}

export function pageInfoByNumber(fieldsData, pages) {
  const infoByNumber = new Map(
    (fieldsData.pages || []).map((page) => [Number(page.page_number), page]),
  );

  for (const [index, page] of pages.entries()) {
    if (!infoByNumber.has(index + 1)) {
      infoByNumber.set(index + 1, {
        page_number: index + 1,
        pdf_width: page.getWidth(),
        pdf_height: page.getHeight(),
      });
    }
  }

  return infoByNumber;
}

export function topOriginRectToPdfRect(bbox, pageInfo, pageSize) {
  const pdfWidth = Number(pageSize.width);
  const pdfHeight = Number(pageSize.height);

  const sourceWidth = Number(
    pageInfo.image_width || pageInfo.pdf_width || pdfWidth,
  );
  const sourceHeight = Number(
    pageInfo.image_height || pageInfo.pdf_height || pdfHeight,
  );

  if (!Array.isArray(bbox) || bbox.length !== 4) {
    throw new Error('Expected bounding box [left, top, right, bottom]');
  }

  const xScale = pdfWidth / sourceWidth;
  const yScale = pdfHeight / sourceHeight;
  const left = Number(bbox[0]) * xScale;
  const right = Number(bbox[2]) * xScale;
  const top = pdfHeight - Number(bbox[1]) * yScale;
  const bottom = pdfHeight - Number(bbox[3]) * yScale;

  return { left, right, top, bottom };
}

function normalizedFontKey(value) {
  return asString(value).trim().toLowerCase().replace(/\s+/g, '-');
}

export async function resolveStandardFont(pdfDoc, fontName, cache) {
  const normalized = normalizedFontKey(fontName || 'helvetica');
  const matched =
    FONT_ALIASES.get(normalized) ||
    FONT_ALIASES.get(normalized.replace(/,/g, '-')) ||
    StandardFonts.Helvetica;

  if (cache.has(matched)) return cache.get(matched);

  const embedded = await pdfDoc.embedFont(matched);
  cache.set(matched, embedded);
  return embedded;
}

export function parseRgbColor(rawValue) {
  const normalized = asString(rawValue).trim();
  if (!normalized) return rgb(0, 0, 0);

  const hexMatch = normalized.match(COLOR_PATTERN);
  if (hexMatch) {
    const hex = hexMatch[1];
    const red = Number.parseInt(hex.slice(0, 2), 16) / 255;
    const green = Number.parseInt(hex.slice(2, 4), 16) / 255;
    const blue = Number.parseInt(hex.slice(4, 6), 16) / 255;
    return rgb(red, green, blue);
  }

  const rgbMatch = normalized.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/i);
  if (rgbMatch) {
    return rgb(
      Number.parseInt(rgbMatch[1], 10) / 255,
      Number.parseInt(rgbMatch[2], 10) / 255,
      Number.parseInt(rgbMatch[3], 10) / 255,
    );
  }

  return rgb(0, 0, 0);
}
