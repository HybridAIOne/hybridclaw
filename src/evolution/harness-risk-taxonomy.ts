export interface RiskTaxonomyEntry<Id extends string> {
  id: Id;
  label: string;
  source: 'nist-ai-rmf-1.0' | 'nist-ai-600-1' | 'owasp-llm-top-10-2025';
}

export const NIST_AI_RMF_CORE_FUNCTIONS = [
  { id: 'govern', label: 'Govern', source: 'nist-ai-rmf-1.0' },
  { id: 'map', label: 'Map', source: 'nist-ai-rmf-1.0' },
  { id: 'measure', label: 'Measure', source: 'nist-ai-rmf-1.0' },
  { id: 'manage', label: 'Manage', source: 'nist-ai-rmf-1.0' },
] as const satisfies readonly RiskTaxonomyEntry<string>[];

export const NIST_GAI_PROFILE_RISKS = [
  {
    id: 'cbrn_information_or_capabilities',
    label: 'CBRN Information or Capabilities',
    source: 'nist-ai-600-1',
  },
  {
    id: 'confabulation',
    label: 'Confabulation',
    source: 'nist-ai-600-1',
  },
  {
    id: 'dangerous_violent_or_hateful_content',
    label: 'Dangerous, Violent, or Hateful Content',
    source: 'nist-ai-600-1',
  },
  {
    id: 'data_privacy',
    label: 'Data Privacy',
    source: 'nist-ai-600-1',
  },
  {
    id: 'environmental_impacts',
    label: 'Environmental Impacts',
    source: 'nist-ai-600-1',
  },
  {
    id: 'harmful_bias_or_homogenization',
    label: 'Harmful Bias or Homogenization',
    source: 'nist-ai-600-1',
  },
  {
    id: 'human_ai_configuration',
    label: 'Human-AI Configuration',
    source: 'nist-ai-600-1',
  },
  {
    id: 'information_integrity',
    label: 'Information Integrity',
    source: 'nist-ai-600-1',
  },
  {
    id: 'information_security',
    label: 'Information Security',
    source: 'nist-ai-600-1',
  },
  {
    id: 'intellectual_property',
    label: 'Intellectual Property',
    source: 'nist-ai-600-1',
  },
  {
    id: 'obscene_degrading_or_abusive_content',
    label: 'Obscene, Degrading, and/or Abusive Content',
    source: 'nist-ai-600-1',
  },
  {
    id: 'value_chain_and_component_integration',
    label: 'Value Chain and Component Integration',
    source: 'nist-ai-600-1',
  },
] as const satisfies readonly RiskTaxonomyEntry<string>[];

export const OWASP_LLM_TOP_10_2025 = [
  {
    id: 'LLM01:2025',
    label: 'Prompt Injection',
    source: 'owasp-llm-top-10-2025',
  },
  {
    id: 'LLM02:2025',
    label: 'Sensitive Information Disclosure',
    source: 'owasp-llm-top-10-2025',
  },
  {
    id: 'LLM03:2025',
    label: 'Supply Chain',
    source: 'owasp-llm-top-10-2025',
  },
  {
    id: 'LLM04:2025',
    label: 'Data and Model Poisoning',
    source: 'owasp-llm-top-10-2025',
  },
  {
    id: 'LLM05:2025',
    label: 'Improper Output Handling',
    source: 'owasp-llm-top-10-2025',
  },
  {
    id: 'LLM06:2025',
    label: 'Excessive Agency',
    source: 'owasp-llm-top-10-2025',
  },
  {
    id: 'LLM07:2025',
    label: 'System Prompt Leakage',
    source: 'owasp-llm-top-10-2025',
  },
  {
    id: 'LLM08:2025',
    label: 'Vector and Embedding Weaknesses',
    source: 'owasp-llm-top-10-2025',
  },
  {
    id: 'LLM09:2025',
    label: 'Misinformation',
    source: 'owasp-llm-top-10-2025',
  },
  {
    id: 'LLM10:2025',
    label: 'Unbounded Consumption',
    source: 'owasp-llm-top-10-2025',
  },
] as const satisfies readonly RiskTaxonomyEntry<string>[];

export type NistAiRmfCoreFunction =
  (typeof NIST_AI_RMF_CORE_FUNCTIONS)[number]['id'];
export type NistGaiProfileRisk = (typeof NIST_GAI_PROFILE_RISKS)[number]['id'];
export type OwaspLlmTop10Risk = (typeof OWASP_LLM_TOP_10_2025)[number]['id'];

export interface AgentRiskReferences {
  nistAiRmf: NistAiRmfCoreFunction[];
  nistGaiProfile: NistGaiProfileRisk[];
  owaspLlmTop10: OwaspLlmTop10Risk[];
}

export interface HarnessRiskCoverageRequirements {
  requireNistAiRmfCore: boolean;
  requireNistGaiProfile: boolean;
  requireOwaspLlmTop10: boolean;
}

export interface RiskCoverageGroup<Id extends string> {
  covered: Id[];
  missing: Id[];
  coveredCount: number;
  totalCount: number;
  taskIdsByRisk: Record<Id, string[]>;
}

export interface HarnessRiskCoverage {
  requirements: HarnessRiskCoverageRequirements;
  nistAiRmf: RiskCoverageGroup<NistAiRmfCoreFunction>;
  nistGaiProfile: RiskCoverageGroup<NistGaiProfileRisk>;
  owaspLlmTop10: RiskCoverageGroup<OwaspLlmTop10Risk>;
  findings: string[];
}

export interface RiskTaggedTask {
  id: string;
  riskReferences?: AgentRiskReferences;
}

const DEFAULT_REQUIREMENTS: HarnessRiskCoverageRequirements = {
  requireNistAiRmfCore: false,
  requireNistGaiProfile: false,
  requireOwaspLlmTop10: false,
};

const RMF_LOOKUP = buildLookup(NIST_AI_RMF_CORE_FUNCTIONS);
const GAI_LOOKUP = buildLookup(NIST_GAI_PROFILE_RISKS);
const OWASP_LOOKUP = buildLookup(OWASP_LLM_TOP_10_2025);

export function emptyRiskReferences(): AgentRiskReferences {
  return {
    nistAiRmf: [],
    nistGaiProfile: [],
    owaspLlmTop10: [],
  };
}

export function parseAgentRiskReferences(value: unknown): AgentRiskReferences {
  if (!isRecord(value)) return emptyRiskReferences();
  const riskRecord = readNestedRiskRecord(value);
  return {
    nistAiRmf: normalizeRiskList(
      readFirst(riskRecord, [
        'nistAiRmf',
        'nistAIRMF',
        'nist_ai_rmf',
        'aiRmf',
        'rmf',
      ]),
      RMF_LOOKUP,
      'NIST AI RMF',
    ),
    nistGaiProfile: normalizeRiskList(
      readFirst(riskRecord, [
        'nistGaiProfile',
        'nistGAIProfile',
        'nist_gai_profile',
        'nistGai',
        'nistGAI',
        'nist_gai',
        'gaiRisks',
        'gai',
      ]),
      GAI_LOOKUP,
      'NIST GAI Profile',
    ),
    owaspLlmTop10: normalizeRiskList(
      readFirst(riskRecord, [
        'owaspLlmTop10',
        'owaspLLMTop10',
        'owasp_llm_top_10',
        'owaspLlm',
        'owaspLLM',
        'llmTop10',
        'genAiTop10',
        'owasp',
      ]),
      OWASP_LOOKUP,
      'OWASP LLM Top 10',
    ),
  };
}

export function parseHarnessRiskCoverageRequirements(
  value: unknown,
): HarnessRiskCoverageRequirements {
  if (!isRecord(value)) return { ...DEFAULT_REQUIREMENTS };
  return {
    requireNistAiRmfCore: readBoolean(value.requireNistAiRmfCore),
    requireNistGaiProfile: readBoolean(value.requireNistGaiProfile),
    requireOwaspLlmTop10: readBoolean(value.requireOwaspLlmTop10),
  };
}

export function calculateHarnessRiskCoverage(
  tasks: RiskTaggedTask[],
  requirements: HarnessRiskCoverageRequirements = DEFAULT_REQUIREMENTS,
): HarnessRiskCoverage {
  const nistAiRmf = calculateGroupCoverage(
    NIST_AI_RMF_CORE_FUNCTIONS,
    tasks,
    (task) => task.riskReferences?.nistAiRmf || [],
  );
  const nistGaiProfile = calculateGroupCoverage(
    NIST_GAI_PROFILE_RISKS,
    tasks,
    (task) => task.riskReferences?.nistGaiProfile || [],
  );
  const owaspLlmTop10 = calculateGroupCoverage(
    OWASP_LLM_TOP_10_2025,
    tasks,
    (task) => task.riskReferences?.owaspLlmTop10 || [],
  );
  const findings = buildCoverageFindings({
    requirements,
    nistAiRmf,
    nistGaiProfile,
    owaspLlmTop10,
  });
  return {
    requirements,
    nistAiRmf,
    nistGaiProfile,
    owaspLlmTop10,
    findings,
  };
}

export function assertHarnessRiskCoverage(coverage: HarnessRiskCoverage): void {
  if (coverage.findings.length > 0) {
    throw new Error(coverage.findings.join('\n'));
  }
}

function buildLookup<Id extends string>(
  entries: readonly RiskTaxonomyEntry<Id>[],
): Map<string, Id> {
  const lookup = new Map<string, Id>();
  for (const entry of entries) {
    const keys = [entry.id, entry.label];
    const owaspMatch = entry.id.match(/^LLM(\d{2}):2025$/u);
    if (owaspMatch?.[1]) {
      keys.push(`LLM${owaspMatch[1]}`);
    }
    for (const key of keys) {
      lookup.set(normalizeRiskKey(key), entry.id);
    }
  }
  return lookup;
}

function readNestedRiskRecord(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const nested = readFirst(record, ['risks', 'risk', 'riskTags', 'agentRisks']);
  return isRecord(nested) ? nested : record;
}

function readFirst(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (Object.hasOwn(record, key)) return record[key];
  }
  return undefined;
}

function normalizeRiskList<Id extends string>(
  value: unknown,
  lookup: Map<string, Id>,
  label: string,
): Id[] {
  const rawValues = readRiskValues(value);
  const normalized: Id[] = [];
  for (const rawValue of rawValues) {
    const id = lookup.get(normalizeRiskKey(rawValue));
    if (!id) {
      throw new Error(`Unknown ${label} risk reference: ${rawValue}`);
    }
    if (!normalized.includes(id)) normalized.push(id);
  }
  return normalized;
}

function readRiskValues(value: unknown): string[] {
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
  }
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function normalizeRiskKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '');
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

function calculateGroupCoverage<Id extends string>(
  entries: readonly RiskTaxonomyEntry<Id>[],
  tasks: RiskTaggedTask[],
  readIds: (task: RiskTaggedTask) => Id[],
): RiskCoverageGroup<Id> {
  const taskIdsByRisk = {} as Record<Id, string[]>;
  for (const entry of entries) {
    taskIdsByRisk[entry.id] = [];
  }
  for (const task of tasks) {
    for (const id of readIds(task)) {
      taskIdsByRisk[id].push(task.id);
    }
  }
  const covered = entries
    .map((entry) => entry.id)
    .filter((id) => taskIdsByRisk[id].length > 0);
  const missing = entries
    .map((entry) => entry.id)
    .filter((id) => taskIdsByRisk[id].length === 0);
  return {
    covered,
    missing,
    coveredCount: covered.length,
    totalCount: entries.length,
    taskIdsByRisk,
  };
}

function buildCoverageFindings(params: {
  requirements: HarnessRiskCoverageRequirements;
  nistAiRmf: RiskCoverageGroup<NistAiRmfCoreFunction>;
  nistGaiProfile: RiskCoverageGroup<NistGaiProfileRisk>;
  owaspLlmTop10: RiskCoverageGroup<OwaspLlmTop10Risk>;
}): string[] {
  const findings: string[] = [];
  if (
    params.requirements.requireNistAiRmfCore &&
    params.nistAiRmf.missing.length > 0
  ) {
    findings.push(
      `NIST AI RMF core coverage is missing: ${params.nistAiRmf.missing.join(', ')}`,
    );
  }
  if (
    params.requirements.requireNistGaiProfile &&
    params.nistGaiProfile.missing.length > 0
  ) {
    findings.push(
      `NIST AI 600-1 GAI risk coverage is missing: ${params.nistGaiProfile.missing.join(', ')}`,
    );
  }
  if (
    params.requirements.requireOwaspLlmTop10 &&
    params.owaspLlmTop10.missing.length > 0
  ) {
    findings.push(
      `OWASP LLM Top 10 2025 coverage is missing: ${params.owaspLlmTop10.missing.join(', ')}`,
    );
  }
  return findings;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
