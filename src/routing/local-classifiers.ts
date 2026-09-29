/**
 * Optional local decision runtimes registered by plugins, never chat providers.
 * Registration does not authorize input or choose an execution model; the gateway
 * retains disclosure, response validation, confidence and tier policy.
 */
export type LocalClassifierAction = 'setup' | 'start' | 'stop';
export interface LocalClassifierState {
  supported: boolean;
  installed: boolean;
  status: 'stopped' | 'setup' | 'starting' | 'running' | 'error';
  error?: string;
}
export interface LocalClassifierRegistration {
  model: string;
  label: string;
  status(): LocalClassifierState;
  command(action: LocalClassifierAction): void;
  predict(input: {
    text: string;
    questions: Record<
      string,
      { type: 'choice'; instructions: string; criteria: Record<string, string> }
    >;
    signal: AbortSignal;
  }): Promise<unknown>;
}
export interface LocalClassifierInfo extends LocalClassifierState {
  model: string;
  label: string;
}
let classifiers = new Map<string, LocalClassifierRegistration>();
export function registerLocalClassifier(
  registration: LocalClassifierRegistration,
): void {
  if (
    !/^local-decision\/[a-z0-9-]{1,64}$/.test(registration.model) ||
    classifiers.has(registration.model)
  )
    throw new Error('Invalid or duplicate local decision model.');
  classifiers.set(registration.model, registration);
}
export function getLocalClassifier(model: string) {
  return classifiers.get(model);
}
export function listLocalClassifiers(): LocalClassifierInfo[] {
  return [...classifiers.values()].map(({ model, label, status }) => ({
    model,
    label,
    ...status(),
  }));
}
export function snapshotLocalClassifiers() {
  return new Map(classifiers);
}
export function restoreLocalClassifiers(
  snapshot: Map<string, LocalClassifierRegistration>,
) {
  classifiers = new Map(snapshot);
}
export function clearLocalClassifiers() {
  classifiers.clear();
}
