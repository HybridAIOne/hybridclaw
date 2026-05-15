'use strict';

const fs = require('node:fs');
const path = require('node:path');

function validatePropertyOptionFromFile({ filePath, propertyName, value }) {
  const resolved = path.resolve(String(filePath || ''));
  const payload = JSON.parse(fs.readFileSync(resolved, 'utf-8'));
  return validatePropertyOption({
    propertyPayload: payload,
    propertyName,
    value,
  });
}

function validatePropertyOption({ propertyPayload, propertyName, value }) {
  const normalizedProperty = String(propertyName || '').trim();
  const normalizedValue = String(value || '').trim();
  if (!normalizedProperty) throw new Error('Property name is required.');
  if (!normalizedValue) throw new Error('Option value is required.');

  const property = findPropertyPayload(propertyPayload, normalizedProperty);
  if (!property) {
    throw new Error(
      `Property ${normalizedProperty} was not found in HubSpot metadata.`,
    );
  }
  const options = Array.isArray(property.options) ? property.options : [];
  const match = options.find(
    (option) =>
      String(option?.value || '').trim() === normalizedValue ||
      String(option?.label || '').trim() === normalizedValue,
  );
  if (!match) {
    const values = options
      .map((option) => String(option?.value || '').trim())
      .filter(Boolean)
      .slice(0, 20);
    throw new Error(
      `Invalid ${normalizedProperty} value "${normalizedValue}". Valid internal values include: ${values.join(', ') || '(none found)'}.`,
    );
  }
  const internalValue = String(match.value || '').trim();
  if (!internalValue) {
    throw new Error(
      `Invalid ${normalizedProperty} option "${normalizedValue}". Matched option is missing an internal value.`,
    );
  }
  return {
    propertyName: normalizedProperty,
    value: internalValue,
    label: String(match.label || '').trim() || internalValue,
    ok: true,
  };
}

function findPropertyPayload(payload, propertyName) {
  if (!payload || typeof payload !== 'object') return null;
  if (
    String(payload.name || '').trim() === propertyName ||
    String(payload.propertyName || '').trim() === propertyName
  ) {
    return payload;
  }
  const results = Array.isArray(payload.results) ? payload.results : [];
  return (
    results.find(
      (entry) =>
        String(entry?.name || '').trim() === propertyName ||
        String(entry?.propertyName || '').trim() === propertyName,
    ) || null
  );
}

module.exports = {
  validatePropertyOption,
  validatePropertyOptionFromFile,
};
