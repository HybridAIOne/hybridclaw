import { expect, test } from 'vitest';

import {
  GatewayRequestError,
  HttpStatusError,
} from '../src/errors/http-status-error.js';
import {
  SkillImportError,
  SkillImportNotFoundError,
} from '../src/skills/skill-errors.js';

test('GatewayRequestError inherits the shared HTTP status error base', () => {
  const error = new GatewayRequestError(418, 'teapot');

  expect(error).toBeInstanceOf(GatewayRequestError);
  expect(error).toBeInstanceOf(HttpStatusError);
  expect(error).toBeInstanceOf(Error);
  expect(error.name).toBe('GatewayRequestError');
  expect(error.statusCode).toBe(418);
});

test('SkillImportNotFoundError inherits the shared skill import base', () => {
  const error = new SkillImportNotFoundError('missing');

  expect(error).toBeInstanceOf(SkillImportNotFoundError);
  expect(error).toBeInstanceOf(SkillImportError);
  expect(error).toBeInstanceOf(Error);
  expect(error.name).toBe('SkillImportNotFoundError');
});
