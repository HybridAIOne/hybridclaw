import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';
import {
  initializeHarnessWorkspace,
  loadEvolutionEvalSuite,
  readHarnessEvolutionSummary,
  renderEvolutionChart,
  runHarnessEvolutionLoop,
} from '../src/evolution/harness-evolution.ts';
import {
  NIST_AI_RMF_CORE_FUNCTIONS,
  NIST_GAI_PROFILE_RISKS,
  OWASP_LLM_TOP_10_2025,
  parseAgentRiskReferences,
} from '../src/evolution/harness-risk-taxonomy.ts';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-risk-'));
}

function writeRiskSuite(
  dir: string,
  body: Record<string, unknown>,
): string {
  const suitePath = path.join(dir, 'risk-suite.json');
  fs.writeFileSync(
    suitePath,
    `${JSON.stringify(
      {
        id: 'agent-risk-suite',
        name: 'Agent Risk Suite',
        ...body,
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );
  return suitePath;
}

function allRiskReferences(): Record<string, string[]> {
  return {
    nistAiRmf: NIST_AI_RMF_CORE_FUNCTIONS.map((entry) => entry.id),
    nistGaiProfile: NIST_GAI_PROFILE_RISKS.map((entry) => entry.id),
    owaspLlmTop10: OWASP_LLM_TOP_10_2025.map((entry) => entry.id),
  };
}

function riskFixtureCommand(scenario: string): string {
  return [
    JSON.stringify(process.execPath),
    JSON.stringify(path.join(process.cwd(), 'tests/fixtures/agent-risk-eval.mjs')),
    scenario,
  ].join(' ');
}

describe('harness risk taxonomy', () => {
  test('tracks NIST AI RMF and OWASP LLM risk categories', () => {
    expect(NIST_AI_RMF_CORE_FUNCTIONS.map((entry) => entry.id)).toEqual([
      'govern',
      'map',
      'measure',
      'manage',
    ]);
    expect(NIST_GAI_PROFILE_RISKS.map((entry) => entry.id)).toEqual([
      'cbrn_information_or_capabilities',
      'confabulation',
      'dangerous_violent_or_hateful_content',
      'data_privacy',
      'environmental_impacts',
      'harmful_bias_or_homogenization',
      'human_ai_configuration',
      'information_integrity',
      'information_security',
      'intellectual_property',
      'obscene_degrading_or_abusive_content',
      'value_chain_and_component_integration',
    ]);
    expect(OWASP_LLM_TOP_10_2025.map((entry) => entry.id)).toEqual([
      'LLM01:2025',
      'LLM02:2025',
      'LLM03:2025',
      'LLM04:2025',
      'LLM05:2025',
      'LLM06:2025',
      'LLM07:2025',
      'LLM08:2025',
      'LLM09:2025',
      'LLM10:2025',
    ]);
  });

  test('normalizes common risk aliases from suite tasks', () => {
    expect(
      parseAgentRiskReferences({
        risks: {
          nistAiRmf: 'Govern, measure',
          nistGaiProfile: ['Data Privacy', 'information-security'],
          owaspLlmTop10: [
            'LLM01',
            'Excessive Agency',
            'LLM07:2025',
          ],
        },
      }),
    ).toEqual({
      nistAiRmf: ['govern', 'measure'],
      nistGaiProfile: ['data_privacy', 'information_security'],
      owaspLlmTop10: ['LLM01:2025', 'LLM06:2025', 'LLM07:2025'],
    });
  });

  test('rejects suites that require OWASP coverage but miss agent risks', () => {
    const cwd = makeTempDir();
    const suitePath = writeRiskSuite(cwd, {
      riskCoverage: {
        requireOwaspLlmTop10: true,
      },
      tasks: [
        {
          id: 'prompt-injection-only',
          risks: {
            owaspLlmTop10: ['LLM01'],
          },
        },
      ],
    });

    expect(() => loadEvolutionEvalSuite(suitePath)).toThrow(
      /OWASP LLM Top 10 2025 coverage is missing: LLM02:2025/,
    );
  });

  test('carries NIST and OWASP risk coverage through harness summaries', async () => {
    const cwd = makeTempDir();
    const targetRoot = path.join(cwd, 'agent-a');
    initializeHarnessWorkspace(targetRoot);
    const suitePath = writeRiskSuite(cwd, {
      riskCoverage: {
        requireNistAiRmfCore: true,
        requireNistGaiProfile: true,
        requireOwaspLlmTop10: true,
      },
      tasks: [
        {
          id: 'agent-risk-regression',
          risks: allRiskReferences(),
        },
      ],
    });

    const result = await runHarnessEvolutionLoop({
      targetRoot,
      suitePath,
      runId: 'risk-coverage',
      rounds: 1,
      freshSeed: true,
      dryRun: true,
      outcomesByRound: [
        [
          {
            taskId: 'agent-risk-regression',
            rollout: 1,
            success: true,
            tokens: 1,
          },
        ],
      ],
    });
    const fromSummary = readHarnessEvolutionSummary(result.summaryPath);

    expect(fromSummary.suite.riskCoverage.nistAiRmf.coveredCount).toBe(4);
    expect(fromSummary.suite.riskCoverage.nistGaiProfile.coveredCount).toBe(
      12,
    );
    expect(fromSummary.suite.riskCoverage.owaspLlmTop10.coveredCount).toBe(10);
    expect(
      fromSummary.suite.riskCoverage.owaspLlmTop10.taskIdsByRisk[
        'LLM06:2025'
      ],
    ).toEqual(['agent-risk-regression']);
    expect(renderEvolutionChart(fromSummary)).toContain(
      'Risk coverage: NIST RMF 4/4; NIST GAI 12/12; OWASP LLM 10/10',
    );
  });

  test('runs command-backed agent risk evals for NIST and OWASP scenarios', async () => {
    const cwd = makeTempDir();
    const targetRoot = path.join(cwd, 'agent-a');
    initializeHarnessWorkspace(targetRoot);
    const suitePath = writeRiskSuite(cwd, {
      tasks: [
        {
          id: 'data-privacy-no-leak',
          command: riskFixtureCommand('data-privacy-pass'),
          risks: {
            nistAiRmf: ['measure'],
            nistGaiProfile: ['data_privacy'],
            owaspLlmTop10: ['LLM02'],
          },
        },
        {
          id: 'prompt-injection-contained',
          command: riskFixtureCommand('prompt-injection-pass'),
          risks: {
            nistAiRmf: ['manage'],
            nistGaiProfile: ['information_integrity', 'information_security'],
            owaspLlmTop10: ['LLM01'],
          },
        },
        {
          id: 'excessive-agency-approval',
          command: riskFixtureCommand('excessive-agency-pass'),
          risks: {
            nistAiRmf: ['govern'],
            nistGaiProfile: ['human_ai_configuration'],
            owaspLlmTop10: ['LLM06'],
          },
        },
      ],
    });

    const result = await runHarnessEvolutionLoop({
      targetRoot,
      suitePath,
      runId: 'command-backed-risk-evals',
      rounds: 1,
      rolloutsPerTask: 1,
      freshSeed: true,
      dryRun: true,
    });

    expect(result.rounds[0]?.metrics).toMatchObject({
      taskCount: 3,
      rolloutCount: 3,
      successCount: 3,
      passAt1: 1,
    });
    expect(
      result.suite.riskCoverage.nistGaiProfile.taskIdsByRisk.data_privacy,
    ).toEqual(['data-privacy-no-leak']);
    expect(
      result.suite.riskCoverage.owaspLlmTop10.taskIdsByRisk['LLM02:2025'],
    ).toEqual(['data-privacy-no-leak']);
  });

  test('captures NIST Data Privacy leakage as a failed eval outcome', async () => {
    const cwd = makeTempDir();
    const targetRoot = path.join(cwd, 'agent-a');
    initializeHarnessWorkspace(targetRoot);
    const suitePath = writeRiskSuite(cwd, {
      tasks: [
        {
          id: 'data-privacy-leak',
          command: riskFixtureCommand('data-privacy-fail'),
          risks: {
            nistAiRmf: ['measure'],
            nistGaiProfile: ['data_privacy'],
            owaspLlmTop10: ['LLM02'],
          },
        },
      ],
    });

    const result = await runHarnessEvolutionLoop({
      targetRoot,
      suitePath,
      runId: 'data-privacy-failure',
      rounds: 1,
      rolloutsPerTask: 1,
      freshSeed: true,
      dryRun: true,
    });
    const rolloutsPath = path.join(
      targetRoot,
      'runs',
      'data-privacy-failure',
      'round-1',
      'cleaned-rollouts.json',
    );
    const rollouts = JSON.parse(fs.readFileSync(rolloutsPath, 'utf-8')) as Array<{
      success: boolean;
      stderr?: string;
    }>;

    expect(result.rounds[0]?.metrics).toMatchObject({
      taskCount: 1,
      successCount: 0,
      passAt1: 0,
    });
    expect(rollouts[0]?.success).toBe(false);
    expect(rollouts[0]?.stderr).toContain('data_privacy leak');
  });
});
