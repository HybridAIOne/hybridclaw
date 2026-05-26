'use strict';

const {
  WRITE_GRANTS,
  buildCreateNoteRequest,
  buildCreateTaskRequest,
  buildPropertiesRequest,
  buildSearchRequest,
  buildUpdateDealStageRequest,
  buildUpdateLifecycleStageRequest,
  parseFlags,
  usageTotalsMeasurement,
} = require('./hubspot-requests.cjs');

function planNaturalLanguage(statement) {
  const text = String(statement || '').trim();
  if (!text) throw new Error('plan requires a request.');
  const lower = text.toLowerCase();
  const actions = [];

  const readObject = lower.includes('contact')
    ? 'contacts'
    : lower.includes('compan') || lower.includes('account')
      ? 'companies'
      : lower.includes('deal') || lower.includes('opportunit')
        ? 'deals'
        : null;

  if (/(find|search|show|list|read|get|lookup)/.test(lower) && readObject) {
    actions.push({
      action: 'search-records',
      object: readObject,
      query:
        extractQuoted(text) ||
        extractAfter(lower, ['for ', 'named ', 'called ']) ||
        '',
      stakesTier: 'green',
      requiresEscalation: false,
    });
  }

  const stageMatch = extractDealStageUpdate(text);
  if (stageMatch) {
    actions.push({
      action: 'update-deal-stage',
      deal: stageMatch.deal,
      stage: stageMatch.stage,
      stakesTier: 'amber',
      requiresEscalation: true,
      requiredGrant: WRITE_GRANTS['update-deal-stage'],
    });
  }

  const lifecycleStage = /\b(?:move|update|set|change)\b/i.test(text)
    ? extractAfter(lower, ['lifecycle stage to ', 'lifecycle to ', 'to '])
    : '';
  if (lifecycleStage && lower.includes('lifecycle')) {
    actions.push({
      action: 'update-lifecycle-stage',
      object: readObject || 'contacts',
      stage: lifecycleStage,
      stakesTier: 'amber',
      requiresEscalation: true,
      requiredGrant: WRITE_GRANTS['update-lifecycle-stage'],
    });
  }

  if (/(log|add|create).*(note|timeline note)/.test(lower)) {
    actions.push({
      action: 'create-note',
      targetObject: readObject || 'deals',
      body: extractQuoted(text) || '',
      stakesTier: 'amber',
      requiresEscalation: true,
      requiredGrant: WRITE_GRANTS['create-note'],
    });
  }

  if (/(create|add|schedule).*(task|todo|follow[- ]?up)/.test(lower)) {
    actions.push({
      action: 'create-task',
      targetObject: readObject || 'contacts',
      subject: extractQuoted(text) || '',
      stakesTier: 'amber',
      requiresEscalation: true,
      requiredGrant: WRITE_GRANTS['create-task'],
    });
  }

  if (actions.length === 0) {
    actions.push({
      action: 'search-records',
      object: readObject || 'contacts',
      query: extractQuoted(text) || text,
      stakesTier: 'green',
      requiresEscalation: false,
    });
  }

  return {
    command: 'plan',
    statement: text,
    actions,
    costMeasurement: usageTotalsMeasurement(),
  };
}

function extractDealStageUpdate(text) {
  const patterns = [
    /^(?:move|update|set|change)\s+(?:the\s+)?(?:deal|opportunity)(?:\s+stage)?\s+for\s+(.+?)\s+to\s+["']?([^"']+?)["']?(?:\s+and\b.*)?$/i,
    /^(?:move|update|set|change)\s+(?:the\s+)?(.+?)\s+(?:deal|opportunity)(?:\s+stage)?\s+to\s+["']?([^"']+?)["']?(?:\s+and\b.*)?$/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return {
        deal: match[1].trim(),
        stage: match[2].trim(),
      };
    }
  }
  return null;
}

function buildWorkflow(statement, args = [], options = {}) {
  const { flags } = parseFlags(args, {
    'record-id': 'string',
    'associate-id': 'string',
    'associate-object': 'string',
    grant: 'string',
    'operator-grant': 'boolean',
  });
  const plan = planNaturalLanguage(statement);
  const steps = [];
  let stepId = 1;

  for (const action of plan.actions) {
    if (action.action === 'search-records') {
      steps.push({
        id: `step-${stepId++}`,
        kind: 'http_request',
        purpose: `Search ${action.object}`,
        stakesTier: 'green',
        httpRequest: buildSearchRequest(
          [
            action.object,
            '--query',
            action.query || plan.statement,
            '--limit',
            '10',
          ],
          options,
        ).httpRequest,
      });
      continue;
    }

    if (action.action === 'update-deal-stage') {
      steps.push({
        id: `step-${stepId++}`,
        kind: 'http_request',
        purpose:
          'Read deal properties so the internal dealstage value can be validated before writing.',
        stakesTier: 'green',
        httpRequest: buildPropertiesRequest(['deals'], options).httpRequest,
      });
      if (!flags['record-id']) {
        steps.push({
          id: `step-${stepId++}`,
          kind: 'http_request',
          purpose: 'Find the target deal ID before updating dealstage.',
          stakesTier: 'green',
          httpRequest: buildSearchRequest(
            [
              'deals',
              '--query',
              action.deal || plan.statement,
              '--limit',
              '10',
            ],
            options,
          ).httpRequest,
        });
        steps.push({
          id: `step-${stepId++}`,
          kind: 'operator',
          purpose:
            'Choose exactly one deal ID from the search results, then rerun workflow with --record-id.',
          requiredInput: 'deal record id',
        });
        continue;
      }
      const writeArgs = [
        flags['record-id'],
        '--stage',
        action.stage,
        ...(flags.grant ? ['--grant', flags.grant] : []),
        ...(flags['operator-grant'] ? ['--operator-grant'] : []),
      ];
      steps.push({
        id: `step-${stepId++}`,
        kind: 'http_request',
        purpose:
          'Update dealstage after the operator confirms the target and validated stage.',
        stakesTier: 'amber',
        requiredGrant: WRITE_GRANTS['update-deal-stage'],
        httpRequest: buildUpdateDealStageRequest(writeArgs).httpRequest,
      });
      continue;
    }

    if (action.action === 'update-lifecycle-stage') {
      steps.push({
        id: `step-${stepId++}`,
        kind: 'http_request',
        purpose: 'Read lifecycle property options before writing.',
        stakesTier: 'green',
        httpRequest: buildPropertiesRequest([action.object], options)
          .httpRequest,
      });
      if (!flags['record-id']) {
        steps.push({
          id: `step-${stepId++}`,
          kind: 'http_request',
          purpose: `Find the target ${action.object} ID before updating lifecyclestage.`,
          stakesTier: 'green',
          httpRequest: buildSearchRequest(
            [action.object, '--query', plan.statement, '--limit', '10'],
            options,
          ).httpRequest,
        });
        steps.push({
          id: `step-${stepId++}`,
          kind: 'operator',
          purpose:
            'Choose exactly one record ID from the search results, then rerun workflow with --record-id.',
          requiredInput: `${action.object} record id`,
        });
        continue;
      }
      const writeArgs = [
        action.object,
        flags['record-id'],
        '--stage',
        action.stage,
        ...(flags.grant ? ['--grant', flags.grant] : []),
        ...(flags['operator-grant'] ? ['--operator-grant'] : []),
      ];
      steps.push({
        id: `step-${stepId++}`,
        kind: 'http_request',
        purpose:
          'Update lifecyclestage after the operator confirms the target and validated stage.',
        stakesTier: 'amber',
        requiredGrant: WRITE_GRANTS['update-lifecycle-stage'],
        httpRequest: buildUpdateLifecycleStageRequest(writeArgs).httpRequest,
      });
      continue;
    }

    if (action.action === 'create-note') {
      const associatedObject = flags['associate-object'] || action.targetObject;
      if (!flags['associate-id']) {
        steps.push({
          id: `step-${stepId++}`,
          kind: 'http_request',
          purpose: `Find the target ${associatedObject} ID before creating a note.`,
          stakesTier: 'green',
          httpRequest: buildSearchRequest(
            [associatedObject, '--query', plan.statement, '--limit', '10'],
            options,
          ).httpRequest,
        });
        steps.push({
          id: `step-${stepId++}`,
          kind: 'operator',
          purpose:
            'Choose exactly one associated record ID, then rerun workflow with --associate-id.',
          requiredInput: `${associatedObject} record id`,
        });
        continue;
      }
      const noteArgs = [
        '--body',
        action.body || plan.statement,
        '--associate-object',
        associatedObject,
        '--associate-id',
        flags['associate-id'],
        ...(flags.grant ? ['--grant', flags.grant] : []),
        ...(flags['operator-grant'] ? ['--operator-grant'] : []),
      ];
      steps.push({
        id: `step-${stepId++}`,
        kind: 'http_request',
        purpose: 'Create HubSpot note after target confirmation.',
        stakesTier: 'amber',
        requiredGrant: WRITE_GRANTS['create-note'],
        httpRequest: buildCreateNoteRequest(noteArgs).httpRequest,
      });
      continue;
    }

    if (action.action === 'create-task') {
      const associatedObject = flags['associate-object'] || action.targetObject;
      if (!flags['associate-id']) {
        steps.push({
          id: `step-${stepId++}`,
          kind: 'http_request',
          purpose: `Find the target ${associatedObject} ID before creating a task.`,
          stakesTier: 'green',
          httpRequest: buildSearchRequest(
            [associatedObject, '--query', plan.statement, '--limit', '10'],
            options,
          ).httpRequest,
        });
        steps.push({
          id: `step-${stepId++}`,
          kind: 'operator',
          purpose:
            'Choose exactly one associated record ID, then rerun workflow with --associate-id.',
          requiredInput: `${associatedObject} record id`,
        });
        continue;
      }
      const taskArgs = [
        '--subject',
        action.subject || plan.statement,
        '--associate-object',
        associatedObject,
        '--associate-id',
        flags['associate-id'],
        ...(flags.grant ? ['--grant', flags.grant] : []),
        ...(flags['operator-grant'] ? ['--operator-grant'] : []),
      ];
      steps.push({
        id: `step-${stepId++}`,
        kind: 'http_request',
        purpose: 'Create HubSpot task after target confirmation.',
        stakesTier: 'amber',
        requiredGrant: WRITE_GRANTS['create-task'],
        httpRequest: buildCreateTaskRequest(taskArgs).httpRequest,
      });
    }
  }

  return {
    command: 'workflow',
    statement: plan.statement,
    actions: plan.actions,
    steps,
    costMeasurement: usageTotalsMeasurement(),
  };
}

function extractQuoted(text) {
  const match = text.match(/["']([^"']+)["']/);
  return match?.[1]?.trim() || '';
}

function extractAfter(text, needles) {
  for (const needle of needles) {
    const index = text.indexOf(needle);
    if (index >= 0) return text.slice(index + needle.length).trim();
  }
  return '';
}

module.exports = {
  buildWorkflow,
  planNaturalLanguage,
};
