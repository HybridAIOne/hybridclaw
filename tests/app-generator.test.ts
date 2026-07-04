import { expect, test } from 'vitest';
import {
  deriveAppTitle,
  extractHtmlDocument,
} from '../src/apps/app-generator.ts';

test('extractHtmlDocument returns a clean full document as-is', () => {
  const doc = '<!DOCTYPE html><html><head><title>X</title></head><body>1</body></html>';
  expect(extractHtmlDocument(doc)).toBe(doc);
});

test('extractHtmlDocument unwraps a fenced ```html block and strips prose', () => {
  const raw = [
    'Sure, here is your app:',
    '```html',
    '<!DOCTYPE html><html><body>game</body></html>',
    '```',
    'Hope you like it!',
  ].join('\n');
  expect(extractHtmlDocument(raw)).toBe(
    '<!DOCTYPE html><html><body>game</body></html>',
  );
});

test('extractHtmlDocument strips <think> reasoning and leading text', () => {
  const raw =
    '<think>I will build...</think>Here:\n<html><body>ok</body></html>\nDone.';
  expect(extractHtmlDocument(raw)).toBe('<html><body>ok</body></html>');
});

test('extractHtmlDocument returns null when no html is present', () => {
  expect(extractHtmlDocument('I cannot do that.')).toBeNull();
});

test('deriveAppTitle prefers the document <title>', () => {
  const html = '<html><head><title>Budget Tracker</title></head></html>';
  expect(deriveAppTitle(html, 'make me a money app')).toBe('Budget Tracker');
});

test('deriveAppTitle falls back to the description', () => {
  expect(deriveAppTitle('<html></html>', '  a snake game  ')).toBe(
    'a snake game',
  );
});

test('deriveAppTitle truncates very long titles', () => {
  const long = 'a'.repeat(200);
  const title = deriveAppTitle('<html></html>', long);
  expect(title.length).toBeLessThanOrEqual(81);
  expect(title.endsWith('…')).toBe(true);
});
