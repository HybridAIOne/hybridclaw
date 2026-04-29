import { Ajv, type ErrorObject } from 'ajv';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { StakesLevel } from '../../container/shared/stakes-classifier.js';
import { isRecord } from '../a2a/utils.js';

export const WORKFLOW_STAKES_LEVELS = ['low', 'medium', 'high'] as const;

export interface WorkflowTransition {
  from: string;
  to: string;
}

export interface WorkflowStep {
  id: string;
  owner_coworker_id: string;
  action: string;
  stakes_threshold?: StakesLevel;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  steps: WorkflowStep[];
  transitions: WorkflowTransition[];
}

export class WorkflowDefinitionValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid workflow definition: ${issues.join('; ')}`);
    this.name = 'WorkflowDefinitionValidationError';
    this.issues = [...issues];
  }
}

export const WORKFLOW_DEFINITION_JSON_SCHEMA = {
  $id: 'https://hybridclaw.dev/schemas/workflow-definition.json',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'steps', 'transitions'],
  properties: {
    id: {
      type: 'string',
      minLength: 1,
      pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$',
    },
    name: { type: 'string', minLength: 1 },
    steps: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'owner_coworker_id', 'action'],
        properties: {
          id: {
            type: 'string',
            minLength: 1,
            pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$',
          },
          owner_coworker_id: { type: 'string', minLength: 1 },
          action: { type: 'string', minLength: 1 },
          stakes_threshold: {
            type: 'string',
            enum: WORKFLOW_STAKES_LEVELS,
          },
        },
      },
    },
    transitions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['from', 'to'],
        properties: {
          from: {
            type: 'string',
            minLength: 1,
            pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$',
          },
          to: {
            type: 'string',
            minLength: 1,
            pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$',
          },
        },
      },
    },
  },
} as const;

const ajv = new Ajv({ allErrors: true });
const validateWorkflowDefinitionSchema = ajv.compile(
  WORKFLOW_DEFINITION_JSON_SCHEMA,
);

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function schemaIssue(error: ErrorObject): string {
  const path = error.instancePath || '/';
  if (error.keyword === 'additionalProperties') {
    const additional = String(error.params.additionalProperty || '').trim();
    return `${path} unexpected field${additional ? `: ${additional}` : ''}`;
  }
  return `${path} ${error.message || 'is invalid'}`;
}

function readStep(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const normalizedStep = { ...value };
  delete normalizedStep.owner_agent_id;
  const owner =
    value.owner_coworker_id !== undefined
      ? value.owner_coworker_id
      : value.owner_agent_id;
  return {
    ...normalizedStep,
    owner_coworker_id: owner,
  };
}

function normalizeDefinition(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    ...value,
    steps: Array.isArray(value.steps) ? value.steps.map(readStep) : value.steps,
  };
}

function validateGraph(definition: WorkflowDefinition): string[] {
  const issues: string[] = [];
  const stepIds = new Set<string>();
  for (const step of definition.steps) {
    if (stepIds.has(step.id)) {
      issues.push(`duplicate step id: ${step.id}`);
      continue;
    }
    stepIds.add(step.id);
  }

  const transitionKeys = new Set<string>();
  for (const transition of definition.transitions) {
    if (!stepIds.has(transition.from)) {
      issues.push(
        `transition from references unknown step: ${transition.from}`,
      );
    }
    if (!stepIds.has(transition.to)) {
      issues.push(`transition to references unknown step: ${transition.to}`);
    }
    if (transition.from === transition.to) {
      issues.push(
        `transition cannot loop to the same step: ${transition.from}`,
      );
    }
    const key = `${transition.from}\0${transition.to}`;
    if (transitionKeys.has(key)) {
      issues.push(
        `duplicate transition: ${transition.from} -> ${transition.to}`,
      );
    }
    transitionKeys.add(key);
  }
  return issues;
}

export function validateWorkflowDefinition(value: unknown): WorkflowDefinition {
  const normalized = normalizeDefinition(value);
  const issues: string[] = [];
  if (!validateWorkflowDefinitionSchema(normalized)) {
    issues.push(
      ...(validateWorkflowDefinitionSchema.errors || []).map(schemaIssue),
    );
  }
  if (issues.length > 0) {
    throw new WorkflowDefinitionValidationError(issues);
  }

  const record = normalized as WorkflowDefinition;
  const definition: WorkflowDefinition = {
    id: normalizeString(record.id),
    name: normalizeString(record.name),
    steps: record.steps.map((step) => ({
      id: normalizeString(step.id),
      owner_coworker_id: normalizeString(step.owner_coworker_id),
      action: normalizeString(step.action),
      ...(step.stakes_threshold
        ? { stakes_threshold: step.stakes_threshold }
        : {}),
    })),
    transitions: record.transitions.map((transition) => ({
      from: normalizeString(transition.from),
      to: normalizeString(transition.to),
    })),
  };

  const graphIssues = validateGraph(definition);
  if (graphIssues.length > 0) {
    throw new WorkflowDefinitionValidationError(graphIssues);
  }
  return definition;
}

export function parseWorkflowDefinitionYaml(raw: string): WorkflowDefinition {
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (error) {
    throw new WorkflowDefinitionValidationError([
      error instanceof Error ? error.message : 'invalid YAML',
    ]);
  }
  return validateWorkflowDefinition(parsed);
}

export function serializeWorkflowDefinitionYaml(
  definition: WorkflowDefinition,
): string {
  return stringifyYaml(validateWorkflowDefinition(definition));
}
