import { makeLazyApi } from './common.js';

type OnboardingApi = typeof import('../onboarding.js');

const onboardingApiState = makeLazyApi<OnboardingApi>(
  () => import('../onboarding.js'),
  'Onboarding API accessed before it was initialized. Call ensureOnboardingApi() first.',
);

export async function ensureOnboardingApi(): Promise<OnboardingApi> {
  return onboardingApiState.ensure();
}
