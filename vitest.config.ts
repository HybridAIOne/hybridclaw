/**
 * Default vitest config — picked up by bare `npx vitest run`.
 *
 * Scopes to root unit tests only. Console workspace tests require jsdom
 * and run separately via `npm --workspace console run test` (or `npm test`
 * which chains both).
 */
export { default } from './vitest.unit.config.ts';
