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

interface SecretValueFixture {
  value: string;
  clientOrgId: TestClientOrg['id'];
}

function owned(
  value: string,
  clientOrgId: TestClientOrg['id'],
): SecretValueFixture {
  return { value, clientOrgId };
}

function clientIdentitySecretValues(): SecretValueFixture[] {
  return testClientOrgs.flatMap((clientOrg) =>
    [clientOrg.name, clientOrg.legalEntity, ...clientOrg.aliases].map((value) =>
      owned(value, clientOrg.id),
    ),
  );
}

const secretValuesByClass: Record<
  SecretFixtureClass,
  readonly SecretValueFixture[]
> = {
  client: [
    ...clientIdentitySecretValues(),
    owned('client_aster_data_room', 'client_aster'),
    owned('client_cobalt_board_channel', 'client_cobalt'),
    owned('client_evergreen_migration_roster', 'client_evergreen'),
    owned('client_aster_tax_profile_TEST', 'client_aster'),
    owned('asterworks_acquisition_targets', 'client_aster'),
    owned('cobalt_partner_map', 'client_cobalt'),
    owned('evergreen_customer_roster', 'client_evergreen'),
    owned('client_aster_priority_pipeline', 'client_aster'),
  ],
  nda: [
    owned('Project Glassline', 'client_aster'),
    owned('Project Harborlight', 'client_cobalt'),
    owned('Project Canopy', 'client_evergreen'),
    owned('AsterWorks unannounced Series B scenario', 'client_aster'),
    owned('Cobalt private churn-risk memo', 'client_cobalt'),
    owned('Evergreen board-only launch timeline', 'client_evergreen'),
    owned('AsterWorks pre-release customer migration plan', 'client_aster'),
    owned('Cobalt internal competitor response brief', 'client_cobalt'),
    owned('Evergreen closed-beta invite list', 'client_evergreen'),
    owned('AsterWorks founder compensation model', 'client_aster'),
    owned('Cobalt M&A diligence checklist', 'client_cobalt'),
    owned('Evergreen pilot failure retrospective', 'client_evergreen'),
    owned('AsterWorks support incident appendix', 'client_aster'),
    owned('Cobalt partner exclusivity memo', 'client_cobalt'),
    owned('Evergreen pre-announcement pricing deck', 'client_evergreen'),
    owned('AsterWorks confidential benchmark results', 'client_aster'),
    owned('data-room index DR-ASTER-001', 'client_aster'),
    owned('data-room index DR-COBALT-014', 'client_cobalt'),
    owned('data-room index DR-EVERGREEN-027', 'client_evergreen'),
    owned('AsterWorks NDA exhibit schedule TEST-2026', 'client_aster'),
  ],
  price: [
    owned('EUR 180000 annual floor', 'client_aster'),
    owned('EUR 220000 annual ceiling', 'client_aster'),
    owned('USD 92000 pilot ceiling', 'client_cobalt'),
    owned('GBP 145000 renewal target', 'client_evergreen'),
    owned('AsterWorks 12 percent discretionary discount', 'client_aster'),
    owned('Cobalt 35 percent migration concession', 'client_cobalt'),
    owned('Evergreen net-45 payment exception', 'client_evergreen'),
    owned('AsterWorks success-fee cap 3 percent', 'client_aster'),
    owned('support uplift 18000 EUR', 'client_aster'),
    owned('integration credit 25000 USD', 'client_cobalt'),
    owned('Evergreen volume tier starts at 400 seats', 'client_evergreen'),
    owned('AsterWorks minimum commit 18 months', 'client_aster'),
    owned('Cobalt price hold expires 2026-09-30', 'client_cobalt'),
    owned('Evergreen expansion quote Q-TEST-118', 'client_evergreen'),
    owned('AsterWorks procurement fallback 15 percent', 'client_aster'),
    owned('Cobalt pilot-to-annual conversion 2.4x', 'client_cobalt'),
    owned('board-approved walkaway 275000 EUR', 'client_aster'),
    owned('Evergreen gross-margin floor 62 percent', 'client_evergreen'),
    owned('services bundle 48000 GBP', 'client_evergreen'),
    owned('renewal-risk reserve 31000 USD', 'client_cobalt'),
  ],
  contract: [
    owned(
      'AsterWorks termination for convenience after 30 days',
      'client_aster',
    ),
    owned('Cobalt mutual NDA expires 2031-12-31', 'client_cobalt'),
    owned('Evergreen liability cap equals 2x fees', 'client_evergreen'),
    owned('AsterWorks security addendum SA-TEST-004', 'client_aster'),
    owned('Cobalt DPA annex version DPA-2026-02', 'client_cobalt'),
    owned('Evergreen non-solicit period 18 months', 'client_evergreen'),
    owned('AsterWorks exclusive beta territory clause', 'client_aster'),
    owned('Cobalt audit rights limited to twice yearly', 'client_cobalt'),
    owned('Evergreen service credit cap 10 percent', 'client_evergreen'),
    owned('AsterWorks custom indemnity carveout', 'client_aster'),
    owned('Cobalt data residency restricted to EU', 'client_cobalt'),
    owned('Evergreen source escrow trigger wording', 'client_evergreen'),
    owned('AsterWorks subprocessor notice window 45 days', 'client_aster'),
    owned('Cobalt assignment requires written consent', 'client_cobalt'),
    owned('Evergreen benchmark publication prohibited', 'client_evergreen'),
    owned('contract exhibit CX-GLASSLINE', 'client_aster'),
    owned('contract exhibit CX-HARBORLIGHT', 'client_cobalt'),
    owned('contract exhibit CX-CANOPY', 'client_evergreen'),
    owned('AsterWorks renewal notice window 120 days', 'client_aster'),
    owned('change-control threshold 15000 EUR', 'client_aster'),
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
  values: readonly SecretValueFixture[],
): readonly TestSecretSample[] {
  return values.map((entry, index) => ({
    id: `${className}_${String(index + 1).padStart(2, '0')}`,
    className,
    label: `${className} sample ${index + 1}`,
    value: entry.value,
    sensitivity: sensitivityBySecretClass[className],
    clientOrgId: entry.clientOrgId,
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
    keywords: testSecretSamples
      .filter((sample) => sample.className !== 'client')
      .map((sample) => ({
        term: sample.value,
        sensitivity: sample.sensitivity,
      })),
  });
}
