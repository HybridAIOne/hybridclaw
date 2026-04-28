import { stringify as stringifyYaml } from 'yaml';
import type { ConfidentialSensitivity } from '../../src/security/confidential-rules.js';

export type TestCoworkerRole =
  | 'briefing-lead'
  | 'builder'
  | 'reviewer'
  | 'compliance'
  | 'finance';

export interface TestCoworker {
  id: string;
  name: string;
  displayName: string;
  owner: string;
  role: TestCoworkerRole;
  skills: readonly string[];
  cv: {
    summary: string;
    capabilities: readonly string[];
    asset: string;
  };
}

export interface TestClientOrg {
  id: string;
  name: string;
  legalEntity: string;
  aliases: readonly string[];
  ndaSensitivity: Extract<ConfidentialSensitivity, 'high' | 'critical'>;
  launchCodename: string;
  contractCode: string;
  billingCurrency: 'EUR' | 'USD' | 'GBP';
}

export type TestThreadIntent = 'chat' | 'handoff' | 'escalate' | 'ack';
export type TestThreadStakes = 'low' | 'medium' | 'high';

export interface TestThreadMessage {
  id: string;
  senderCoworkerId: string;
  recipientCoworkerId: string;
  intent: TestThreadIntent;
  content: string;
  createdAt: string;
  parentMessageId?: string;
}

export interface TestThread {
  id: string;
  clientOrgId: string;
  title: string;
  ownerCoworkerId: string;
  stakes: TestThreadStakes;
  containsNdaData: boolean;
  messages: readonly TestThreadMessage[];
}

export const SECRET_FIXTURE_CLASSES = [
  'client',
  'nda',
  'price',
  'contract',
] as const;

export type SecretFixtureClass = (typeof SECRET_FIXTURE_CLASSES)[number];

export interface TestSecretSample {
  id: string;
  className: SecretFixtureClass;
  label: string;
  value: string;
  sensitivity: ConfidentialSensitivity;
  clientOrgId: string;
}

export const testCoworkers: readonly TestCoworker[] = [
  {
    id: 'coworker_briefing',
    name: 'briefing',
    displayName: 'Briefing Lead',
    owner: 'operator_alpha',
    role: 'briefing-lead',
    skills: ['research-brief', 'client-intake', 'source-synthesis'],
    cv: {
      summary: 'Turns client context into concise, sourced working briefs.',
      capabilities: ['research', 'briefing', 'client-context'],
      asset: 'agents/coworker_briefing/CV.md',
    },
  },
  {
    id: 'coworker_builder',
    name: 'builder',
    displayName: 'Builder',
    owner: 'operator_alpha',
    role: 'builder',
    skills: ['implementation-plan', 'artifact-drafting', 'handoff-notes'],
    cv: {
      summary: 'Builds client-facing artifacts from approved briefs.',
      capabilities: ['drafting', 'implementation', 'handoff'],
      asset: 'agents/coworker_builder/CV.md',
    },
  },
  {
    id: 'coworker_reviewer',
    name: 'reviewer',
    displayName: 'Reviewer',
    owner: 'operator_beta',
    role: 'reviewer',
    skills: ['quality-review', 'fact-check', 'return-for-revision'],
    cv: {
      summary: 'Reviews deliverables and returns precise revision notes.',
      capabilities: ['review', 'quality', 'revision'],
      asset: 'agents/coworker_reviewer/CV.md',
    },
  },
  {
    id: 'coworker_compliance',
    name: 'compliance',
    displayName: 'Compliance Watch',
    owner: 'operator_beta',
    role: 'compliance',
    skills: ['nda-screening', 'policy-check', 'leak-triage'],
    cv: {
      summary: 'Screens work for NDA and policy-sensitive material.',
      capabilities: ['compliance', 'redaction', 'escalation'],
      asset: 'agents/coworker_compliance/CV.md',
    },
  },
  {
    id: 'coworker_finance',
    name: 'finance',
    displayName: 'Finance Analyst',
    owner: 'operator_gamma',
    role: 'finance',
    skills: ['budget-watch', 'pricing-review', 'cost-reporting'],
    cv: {
      summary: 'Tracks pricing, budget thresholds, and spend-sensitive work.',
      capabilities: ['pricing', 'budgeting', 'cost-control'],
      asset: 'agents/coworker_finance/CV.md',
    },
  },
];

export const testClientOrgs: readonly TestClientOrg[] = [
  {
    id: 'client_aster',
    name: 'AsterWorks Labs',
    legalEntity: 'AsterWorks EU Test GmbH',
    aliases: ['AWL', 'Project Glassline sponsor'],
    ndaSensitivity: 'critical',
    launchCodename: 'Project Glassline',
    contractCode: 'CONTRACT-ASTER-2026-001',
    billingCurrency: 'EUR',
  },
  {
    id: 'client_cobalt',
    name: 'Cobalt Harbor Studio',
    legalEntity: 'Cobalt Harbor Test Ltd',
    aliases: ['CHS', 'Harborlight team'],
    ndaSensitivity: 'high',
    launchCodename: 'Project Harborlight',
    contractCode: 'CONTRACT-COBALT-2026-014',
    billingCurrency: 'USD',
  },
  {
    id: 'client_evergreen',
    name: 'Evergreen Vector Works',
    legalEntity: 'Evergreen Vector Test PLC',
    aliases: ['EVW', 'Canopy account'],
    ndaSensitivity: 'critical',
    launchCodename: 'Project Canopy',
    contractCode: 'CONTRACT-EVERGREEN-2026-027',
    billingCurrency: 'GBP',
  },
];

const secretValuesByClass: Record<SecretFixtureClass, readonly string[]> = {
  client: [
    'AsterWorks Labs',
    'AWL',
    'AsterWorks EU Test GmbH',
    'Cobalt Harbor Studio',
    'CHS',
    'Cobalt Harbor Test Ltd',
    'Evergreen Vector Works',
    'EVW',
    'Evergreen Vector Test PLC',
    'client_aster_data_room',
    'client_aster_private_channel',
    'client_cobalt_board_channel',
    'client_evergreen_migration_roster',
    'client_aster_tax_profile_TEST',
    'client_cobalt_contract_owner',
    'client_evergreen_procurement_owner',
    'asterworks_acquisition_targets',
    'cobalt_partner_map',
    'evergreen_customer_roster',
    'test_client_priority_pipeline',
  ],
  nda: [
    'Project Glassline',
    'Project Harborlight',
    'Project Canopy',
    'unannounced Series B scenario',
    'private churn-risk memo',
    'board-only launch timeline',
    'pre-release customer migration plan',
    'internal competitor response brief',
    'closed-beta invite list',
    'founder compensation model',
    'M&A diligence checklist',
    'pilot failure retrospective',
    'support incident appendix',
    'partner exclusivity memo',
    'pre-announcement pricing deck',
    'confidential benchmark results',
    'data-room index DR-ASTER-001',
    'data-room index DR-COBALT-014',
    'data-room index DR-EVERGREEN-027',
    'NDA exhibit schedule TEST-2026',
  ],
  price: [
    'EUR 180000 annual floor',
    'EUR 220000 annual ceiling',
    'USD 92000 pilot ceiling',
    'GBP 145000 renewal target',
    '12 percent discretionary discount',
    '35 percent migration concession',
    'net-45 payment exception',
    'success-fee cap 3 percent',
    'support uplift 18000 EUR',
    'integration credit 25000 USD',
    'volume tier starts at 400 seats',
    'minimum commit 18 months',
    'price hold expires 2026-09-30',
    'expansion quote Q-TEST-118',
    'procurement fallback 15 percent',
    'pilot-to-annual conversion 2.4x',
    'board-approved walkaway 275000 EUR',
    'gross-margin floor 62 percent',
    'services bundle 48000 GBP',
    'renewal-risk reserve 31000 USD',
  ],
  contract: [
    'termination for convenience after 30 days',
    'mutual NDA expires 2031-12-31',
    'liability cap equals 2x fees',
    'security addendum SA-TEST-004',
    'DPA annex version DPA-2026-02',
    'non-solicit period 18 months',
    'exclusive beta territory clause',
    'audit rights limited to twice yearly',
    'service credit cap 10 percent',
    'custom indemnity carveout',
    'data residency restricted to EU',
    'source escrow trigger wording',
    'subprocessor notice window 45 days',
    'assignment requires written consent',
    'benchmark publication prohibited',
    'contract exhibit CX-GLASSLINE',
    'contract exhibit CX-HARBORLIGHT',
    'contract exhibit CX-CANOPY',
    'renewal notice window 120 days',
    'change-control threshold 15000 EUR',
  ],
};

const sensitivityBySecretClass: Record<
  SecretFixtureClass,
  ConfidentialSensitivity
> = {
  client: 'high',
  nda: 'critical',
  price: 'high',
  contract: 'critical',
};

function makeSecretSamples(
  className: SecretFixtureClass,
  values: readonly string[],
): readonly TestSecretSample[] {
  return values.map((value, index) => ({
    id: `${className}_${String(index + 1).padStart(2, '0')}`,
    className,
    label: `${className} sample ${index + 1}`,
    value,
    sensitivity: sensitivityBySecretClass[className],
    clientOrgId: testClientOrgs[index % testClientOrgs.length].id,
  }));
}

export const testSecretSamplesByClass: Record<
  SecretFixtureClass,
  readonly TestSecretSample[]
> = {
  client: makeSecretSamples('client', secretValuesByClass.client),
  nda: makeSecretSamples('nda', secretValuesByClass.nda),
  price: makeSecretSamples('price', secretValuesByClass.price),
  contract: makeSecretSamples('contract', secretValuesByClass.contract),
};

export const testSecretSamples: readonly TestSecretSample[] =
  SECRET_FIXTURE_CLASSES.flatMap(
    (className) => testSecretSamplesByClass[className],
  );

export const testThreads: readonly TestThread[] = [
  {
    id: 'thread_launch_brief',
    clientOrgId: 'client_aster',
    title: 'Launch brief handoff',
    ownerCoworkerId: 'coworker_briefing',
    stakes: 'high',
    containsNdaData: true,
    messages: [
      {
        id: 'msg_launch_brief_1',
        senderCoworkerId: 'coworker_briefing',
        recipientCoworkerId: 'coworker_builder',
        intent: 'handoff',
        content: 'Draft from the Project Glassline source brief.',
        createdAt: '2026-04-20T09:00:00.000Z',
      },
      {
        id: 'msg_launch_brief_2',
        senderCoworkerId: 'coworker_builder',
        recipientCoworkerId: 'coworker_reviewer',
        intent: 'ack',
        content: 'Accepted; building the first client-facing artifact.',
        createdAt: '2026-04-20T09:03:00.000Z',
        parentMessageId: 'msg_launch_brief_1',
      },
    ],
  },
  {
    id: 'thread_price_review',
    clientOrgId: 'client_cobalt',
    title: 'Pilot pricing review',
    ownerCoworkerId: 'coworker_finance',
    stakes: 'high',
    containsNdaData: true,
    messages: [
      {
        id: 'msg_price_review_1',
        senderCoworkerId: 'coworker_finance',
        recipientCoworkerId: 'coworker_compliance',
        intent: 'escalate',
        content: 'Check whether USD 92000 pilot ceiling can leave the model.',
        createdAt: '2026-04-20T10:00:00.000Z',
      },
    ],
  },
  {
    id: 'thread_nda_triage',
    clientOrgId: 'client_evergreen',
    title: 'NDA triage',
    ownerCoworkerId: 'coworker_compliance',
    stakes: 'high',
    containsNdaData: true,
    messages: [
      {
        id: 'msg_nda_triage_1',
        senderCoworkerId: 'coworker_reviewer',
        recipientCoworkerId: 'coworker_compliance',
        intent: 'chat',
        content: 'Project Canopy references need masking before review.',
        createdAt: '2026-04-20T11:00:00.000Z',
      },
    ],
  },
  {
    id: 'thread_copy_pass',
    clientOrgId: 'client_aster',
    title: 'Copy pass',
    ownerCoworkerId: 'coworker_reviewer',
    stakes: 'medium',
    containsNdaData: false,
    messages: [
      {
        id: 'msg_copy_pass_1',
        senderCoworkerId: 'coworker_builder',
        recipientCoworkerId: 'coworker_reviewer',
        intent: 'chat',
        content: 'Please tighten the public launch summary.',
        createdAt: '2026-04-20T12:00:00.000Z',
      },
    ],
  },
  {
    id: 'thread_budget_check',
    clientOrgId: 'client_cobalt',
    title: 'Budget threshold check',
    ownerCoworkerId: 'coworker_finance',
    stakes: 'medium',
    containsNdaData: true,
    messages: [
      {
        id: 'msg_budget_check_1',
        senderCoworkerId: 'coworker_builder',
        recipientCoworkerId: 'coworker_finance',
        intent: 'chat',
        content: 'The integration credit 25000 USD changes margin.',
        createdAt: '2026-04-20T13:00:00.000Z',
      },
    ],
  },
  {
    id: 'thread_contract_summary',
    clientOrgId: 'client_evergreen',
    title: 'Contract summary',
    ownerCoworkerId: 'coworker_compliance',
    stakes: 'high',
    containsNdaData: true,
    messages: [
      {
        id: 'msg_contract_summary_1',
        senderCoworkerId: 'coworker_compliance',
        recipientCoworkerId: 'coworker_reviewer',
        intent: 'chat',
        content: 'Summarize liability cap equals 2x fees without leaking it.',
        createdAt: '2026-04-20T14:00:00.000Z',
      },
    ],
  },
  {
    id: 'thread_data_room_cleanup',
    clientOrgId: 'client_aster',
    title: 'Data-room cleanup',
    ownerCoworkerId: 'coworker_briefing',
    stakes: 'medium',
    containsNdaData: true,
    messages: [
      {
        id: 'msg_data_room_cleanup_1',
        senderCoworkerId: 'coworker_briefing',
        recipientCoworkerId: 'coworker_compliance',
        intent: 'chat',
        content: 'Remove data-room index DR-ASTER-001 from the prompt.',
        createdAt: '2026-04-20T15:00:00.000Z',
      },
    ],
  },
  {
    id: 'thread_revision_handoff',
    clientOrgId: 'client_cobalt',
    title: 'Revision handoff',
    ownerCoworkerId: 'coworker_reviewer',
    stakes: 'medium',
    containsNdaData: false,
    messages: [
      {
        id: 'msg_revision_handoff_1',
        senderCoworkerId: 'coworker_reviewer',
        recipientCoworkerId: 'coworker_builder',
        intent: 'handoff',
        content: 'Return for revision with tighter source citations.',
        createdAt: '2026-04-20T16:00:00.000Z',
      },
    ],
  },
  {
    id: 'thread_compliance_screen',
    clientOrgId: 'client_evergreen',
    title: 'Compliance screen',
    ownerCoworkerId: 'coworker_compliance',
    stakes: 'high',
    containsNdaData: true,
    messages: [
      {
        id: 'msg_compliance_screen_1',
        senderCoworkerId: 'coworker_builder',
        recipientCoworkerId: 'coworker_compliance',
        intent: 'escalate',
        content: 'Screen contract exhibit CX-CANOPY before sending.',
        createdAt: '2026-04-20T17:00:00.000Z',
      },
    ],
  },
  {
    id: 'thread_client_update',
    clientOrgId: 'client_aster',
    title: 'Client update',
    ownerCoworkerId: 'coworker_briefing',
    stakes: 'low',
    containsNdaData: false,
    messages: [
      {
        id: 'msg_client_update_1',
        senderCoworkerId: 'coworker_briefing',
        recipientCoworkerId: 'coworker_builder',
        intent: 'chat',
        content: 'Prepare a safe weekly progress note.',
        createdAt: '2026-04-20T18:00:00.000Z',
      },
    ],
  },
];

export const trustedCoworkerFixtures = {
  coworkers: testCoworkers,
  clientOrgs: testClientOrgs,
  threads: testThreads,
  secretSamplesByClass: testSecretSamplesByClass,
  secretSamples: testSecretSamples,
} as const;

export function requireTestCoworker(id: string): TestCoworker {
  const coworker = testCoworkers.find((entry) => entry.id === id);
  if (!coworker) throw new Error(`Unknown test coworker: ${id}`);
  return coworker;
}

export function requireTestClientOrg(id: string): TestClientOrg {
  const clientOrg = testClientOrgs.find((entry) => entry.id === id);
  if (!clientOrg) throw new Error(`Unknown test client org: ${id}`);
  return clientOrg;
}

export function trustedCoworkerConfidentialYaml(): string {
  return stringifyYaml({
    version: 1,
    clients: testClientOrgs.map((clientOrg) => ({
      name: clientOrg.name,
      aliases: [clientOrg.legalEntity, ...clientOrg.aliases],
      sensitivity: clientOrg.ndaSensitivity,
    })),
    projects: testClientOrgs.map((clientOrg) => ({
      name: clientOrg.launchCodename,
      sensitivity: clientOrg.ndaSensitivity,
    })),
    keywords: testSecretSamples.map((sample) => ({
      term: sample.value,
      sensitivity: sample.sensitivity,
    })),
  });
}
