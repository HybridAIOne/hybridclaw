import { describe, expect, test } from 'vitest';
import { markdownToWhatsApp } from '../plugins/whatsapp/src/markdown.js';

describe('whatsapp markdown conversion', () => {
  test('converts bold italic and strike syntax', () => {
    expect(markdownToWhatsApp('**bold** *italic* ~~gone~~')).toBe(
      '*bold* _italic_ ~gone~',
    );
  });

  test('preserves fenced and inline code', () => {
    expect(markdownToWhatsApp('Use `**literal**` and ```**block**```')).toBe(
      'Use `**literal**` and ```**block**```',
    );
  });
});
