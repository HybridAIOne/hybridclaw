import { describe, expect, test } from 'vitest';

import {
  ActorValidationError,
  createAgentActor,
  createUserActor,
  isAgentActor,
  isUserActor,
  parseActor,
  serializeActor,
} from '../src/identity/actor.js';

describe('polymorphic actors', () => {
  test('round-trips user and agent actors through serialize and parse', () => {
    const user = createUserActor(' Lena@HybridAI ');
    const agent = createAgentActor(' Support@Lena@Inst-7F3A ');

    expect(user).toEqual({ type: 'user', id: 'lena@hybridai' });
    expect(agent).toEqual({
      type: 'agent',
      id: 'support@lena@inst-7f3a',
    });
    expect(parseActor(serializeActor(user))).toEqual(user);
    expect(parseActor(serializeActor(agent))).toEqual(agent);
  });

  test('type guards validate the tagged union shape', () => {
    expect(isUserActor({ type: 'user', id: 'lena@hybridai' })).toBe(true);
    expect(isAgentActor({ type: 'agent', id: 'support@lena@inst-7f3a' })).toBe(
      true,
    );
    expect(isUserActor({ type: 'agent', id: 'support@lena@inst-7f3a' })).toBe(
      false,
    );
    expect(isAgentActor({ type: 'user', id: 'lena@hybridai' })).toBe(false);
    expect(isUserActor({ type: 'user', id: 'legacy-user' })).toBe(false);
    expect(isUserActor({ type: 'user', id: 123 })).toBe(false);
    expect(isAgentActor({ type: 'agent', id: 123 })).toBe(false);
  });

  test('rejects actors outside the existing user and agent id formats', () => {
    expect(() => parseActor('team:lena@hybridai')).toThrow(
      ActorValidationError,
    );
    expect(() => createUserActor('legacy-user')).toThrow(ActorValidationError);
    expect(() => createAgentActor('legacy-agent')).toThrow(
      ActorValidationError,
    );
  });
});
