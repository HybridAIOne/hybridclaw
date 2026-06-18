import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminHarnessEvolutionResponse } from '../api/types';
import { renderWithProviders } from '../test-utils';
import { HarnessEvolutionPage } from './harness-evolution';

const createHarnessEvolutionStarterSuitesMock = vi.fn();
const createHarnessEvolutionSuitesMock = vi.fn();
const createHarnessEvolutionSpreadsheetExampleMock = vi.fn();
const fetchHarnessEvolutionRunsMock =
  vi.fn<
    (
      token: string,
      targetRoot: string,
    ) => Promise<AdminHarnessEvolutionResponse>
  >();
const fetchHarnessEvolutionRunMock = vi.fn();
const fetchHarnessEvolutionManifestMock = vi.fn();
const initializeHarnessEvolutionTargetMock = vi.fn();
const startHarnessEvolutionRunMock = vi.fn();
const useAuthMock = vi.fn();

vi.mock('../api/client', () => ({
  createHarnessEvolutionSuites: (token: string, payload: unknown) =>
    createHarnessEvolutionSuitesMock(token, payload),
  createHarnessEvolutionStarterSuites: (token: string, targetRoot: string) =>
    createHarnessEvolutionStarterSuitesMock(token, targetRoot),
  createHarnessEvolutionSpreadsheetExample: (
    token: string,
    targetRoot: string,
  ) => createHarnessEvolutionSpreadsheetExampleMock(token, targetRoot),
  fetchHarnessEvolutionManifest: (
    token: string,
    targetRoot: string,
    manifestPath: string,
  ) => fetchHarnessEvolutionManifestMock(token, targetRoot, manifestPath),
  fetchHarnessEvolutionRun: (
    token: string,
    targetRoot: string,
    summaryPath: string,
  ) => fetchHarnessEvolutionRunMock(token, targetRoot, summaryPath),
  fetchHarnessEvolutionRuns: (token: string, targetRoot: string) =>
    fetchHarnessEvolutionRunsMock(token, targetRoot),
  initializeHarnessEvolutionTarget: (token: string, targetRoot: string) =>
    initializeHarnessEvolutionTargetMock(token, targetRoot),
  startHarnessEvolutionRun: (token: string, payload: unknown) =>
    startHarnessEvolutionRunMock(token, payload),
}));

vi.mock('../auth', () => ({
  useAuth: () => useAuthMock(),
}));

describe('HarnessEvolutionPage', () => {
  beforeEach(() => {
    createHarnessEvolutionStarterSuitesMock.mockReset();
    createHarnessEvolutionSuitesMock.mockReset();
    createHarnessEvolutionSpreadsheetExampleMock.mockReset();
    fetchHarnessEvolutionRunsMock.mockReset();
    fetchHarnessEvolutionRunMock.mockReset();
    fetchHarnessEvolutionManifestMock.mockReset();
    initializeHarnessEvolutionTargetMock.mockReset();
    startHarnessEvolutionRunMock.mockReset();
    useAuthMock.mockReturnValue({ token: 'test-token' });
    fetchHarnessEvolutionRunsMock.mockResolvedValue({
      targetRoot: '/tmp/harness-agent',
      runs: [],
    });
  });

  it('generates starter suite JSON paths from the start form', async () => {
    createHarnessEvolutionStarterSuitesMock.mockResolvedValue({
      targetRoot: '/tmp/harness-agent',
      starterSuites: {
        trainSuitePath: '/tmp/harness-agent/evals/train-suite.json',
        selectionSuitePath: '/tmp/harness-agent/evals/selection-suite.json',
        verifierPath: '/tmp/harness-agent/verifier/check-starter-memory.mjs',
      },
      runs: [],
    });

    renderWithProviders(<HarnessEvolutionPage />);

    expect(
      screen.getByRole('button', { name: 'Create starter suites' }),
    ).not.toBeNull();
    expect(screen.getByText('evals/train-suite.json')).not.toBeNull();
    expect(screen.getByText('evals/selection-suite.json')).not.toBeNull();

    fireEvent.click(
      screen.getByRole('button', { name: 'Create starter suites' }),
    );

    await waitFor(() => {
      expect(
        (
          screen.getByPlaceholderText(
            '/path/to/train-suite.json',
          ) as HTMLInputElement
        ).value,
      ).toBe('/tmp/harness-agent/evals/train-suite.json');
      expect(
        (
          screen.getByPlaceholderText(
            '/path/to/selection-suite.json',
          ) as HTMLInputElement
        ).value,
      ).toBe('/tmp/harness-agent/evals/selection-suite.json');
    });
    expect(createHarnessEvolutionStarterSuitesMock).toHaveBeenCalledWith(
      'test-token',
      '~/.hybridclaw/data/harness-evolution/demo-agent',
    );
  });

  it('generates SpreadsheetBench-style suite JSON paths from the start form', async () => {
    createHarnessEvolutionSpreadsheetExampleMock.mockResolvedValue({
      targetRoot: '/tmp/harness-agent',
      starterSuites: {
        trainSuitePath:
          '/tmp/harness-agent/evals/spreadsheetbench-formula-train.json',
        selectionSuitePath:
          '/tmp/harness-agent/evals/spreadsheetbench-formula-selection.json',
        verifierPath:
          '/tmp/harness-agent/verifier/check-spreadsheetbench-formula.mjs',
      },
      runs: [],
    });

    renderWithProviders(<HarnessEvolutionPage />);

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Create SpreadsheetBench example',
      }),
    );

    await waitFor(() => {
      expect(
        (
          screen.getByPlaceholderText(
            '/path/to/train-suite.json',
          ) as HTMLInputElement
        ).value,
      ).toBe('/tmp/harness-agent/evals/spreadsheetbench-formula-train.json');
      expect(createHarnessEvolutionSpreadsheetExampleMock).toHaveBeenCalledWith(
        'test-token',
        '~/.hybridclaw/data/harness-evolution/demo-agent',
      );
    });
  });

  it('builds train and selection suite JSON from command rows', async () => {
    createHarnessEvolutionSuitesMock.mockResolvedValue({
      targetRoot: '/tmp/harness-agent',
      starterSuites: {
        trainSuitePath: '/tmp/harness-agent/evals/harness-eval-train.json',
        selectionSuitePath:
          '/tmp/harness-agent/evals/harness-eval-selection.json',
        verifierPath: '',
      },
      runs: [],
    });

    renderWithProviders(<HarnessEvolutionPage />);

    fireEvent.change(screen.getByLabelText('Train commands'), {
      target: { value: 'train-smoke: node verifier/train.mjs {targetRoot}' },
    });
    fireEvent.change(screen.getByLabelText('Selection commands'), {
      target: {
        value: 'selection-smoke: node verifier/selection.mjs {targetRoot}',
      },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Save suites and fill fields' }),
    );

    await waitFor(() => {
      expect(createHarnessEvolutionSuitesMock).toHaveBeenCalledWith(
        'test-token',
        expect.objectContaining({
          targetRoot: '~/.hybridclaw/data/harness-evolution/demo-agent',
          tasks: [
            {
              id: 'train-smoke',
              command: 'node verifier/train.mjs {targetRoot}',
              split: 'train',
            },
            {
              id: 'selection-smoke',
              command: 'node verifier/selection.mjs {targetRoot}',
              split: 'selection',
            },
          ],
        }),
      );
      expect(
        (
          screen.getByPlaceholderText(
            '/path/to/train-suite.json',
          ) as HTMLInputElement
        ).value,
      ).toBe('/tmp/harness-agent/evals/harness-eval-train.json');
    });
  });
});
