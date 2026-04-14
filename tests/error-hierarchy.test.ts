import { expect, test } from 'vitest';

import { GatewayRequestError } from '../src/errors/gateway-request-error.js';
import {
  SkillImportError,
  SkillImportNotFoundError,
} from '../src/skills/skill-errors.js';

test('GatewayRequestError carries its HTTP status code', () => {
  const error = new GatewayRequestError(418, 'teapot');

  expect(error).toBeInstanceOf(GatewayRequestError);
  expect(error).toBeInstanceOf(Error);
  expect(error.name).toBe('GatewayRequestError');
  expect(error.statusCode).toBe(418);
});

test('GatewayRequestError rejects invalid HTTP status codes', () => {
  expect(() => new GatewayRequestError(99, 'too low')).toThrow(
    new RangeError('Invalid HTTP status code: 99'),
  );
  expect(() => new GatewayRequestError(600, 'too high')).toThrow(
    new RangeError('Invalid HTTP status code: 600'),
  );
  expect(() => new GatewayRequestError(200.5, 'fractional')).toThrow(
    new RangeError('Invalid HTTP status code: 200.5'),
  );
});

test('GatewayRequestError statusCode is immutable after construction', () => {
  const error = new GatewayRequestError(418, 'teapot');

  expect(() => {
    (error as { statusCode: number }).statusCode = 999;
  }).toThrow(TypeError);
  expect(error.statusCode).toBe(418);
});

test('SkillImportNotFoundError inherits the shared skill import base', () => {
  const error = new SkillImportNotFoundError('missing');

  expect(error).toBeInstanceOf(SkillImportNotFoundError);
  expect(error).toBeInstanceOf(SkillImportError);
  expect(error).toBeInstanceOf(Error);
  expect(error.name).toBe('SkillImportNotFoundError');
});
