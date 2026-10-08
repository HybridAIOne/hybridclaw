import { describe, expect, test } from 'vitest';

import {
  ActorValidationError,
  createAgentActor,
  createUserActor,
  normalizeActor,
} from '../src/identity/actor.js';

describe('polymorphic actors', () => {
  test('normalizes user and agent actor ids', () => {
    const user = createUserActor(' Lena@HybridAI ');
    const agent = createAgentActor(' Support@Lena@Inst-7F3A ');

    expect(user).toEqual({ type: 'user', id: 'lena@hybridai' });
    expect(agent).toEqual({
      type: 'agent',
      id: 'support@lena@inst-7f3a',
    });
    expect(normalizeActor({ type: ' agent ', id: agent.id })).toEqual(agent);
  });

  test('rejects actors outside the existing user and agent id formats', () => {
    expect(() =>
      normalizeActor({ type: 'team', id: 'lena@hybridai' }),
    ).toThrow(ActorValidationError);
    expect(() => createUserActor('legacy-user')).toThrow(ActorValidationError);
    expect(() => createAgentActor('legacy-agent')).toThrow(
      ActorValidationError,
    );
  });
});
