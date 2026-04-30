import { Ajv, type AnySchemaObject, type ErrorObject } from 'ajv';
import { parse as parseYaml } from 'yaml';

export const WORKFLOW_STAKES_THRESHOLDS = ['low', 'medium', 'high'] as const;

export type WorkflowStakesThreshold =
  (typeof WORKFLOW_STAKES_THRESHOLDS)[number];

export interface WorkflowStepDefinition {
  id: string;
  owner_coworker_id: string;
  action: string;
  stakes_threshold?: WorkflowStakesThreshold;
}

export interface WorkflowTransitionDefinition {
  from: string;
  to: string;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  steps: WorkflowStepDefinition[];
  transitions: WorkflowTransitionDefinition[];
}

export const WORKFLOW_DEFINITION_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://hybridclaw.local/schemas/workflow-definition.schema.json',
  title: 'HybridClaw workflow definition',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'steps', 'transitions'],
  properties: {
    id: {
      type: 'string',
      minLength: 1,
    },
    name: {
      type: 'string',
      minLength: 1,
    },
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
          },
          owner_coworker_id: {
            type: 'string',
            minLength: 1,
          },
          action: {
            type: 'string',
            minLength: 1,
          },
          stakes_threshold: {
            type: 'string',
            enum: WORKFLOW_STAKES_THRESHOLDS,
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
          },
          to: {
            type: 'string',
            minLength: 1,
          },
        },
      },
    },
  },
} satisfies AnySchemaObject;

const workflowDefinitionValidator = new Ajv({
  allErrors: true,
  removeAdditional: false,
  strictSchema: true,
  strictTypes: false,
}).compile<WorkflowDefinition>(WORKFLOW_DEFINITION_SCHEMA);

function formatJsonSchemaError(error: ErrorObject): string {
  const pointer = error.instancePath || '/';
  if (
    error.keyword === 'required' &&
    typeof error.params.missingProperty === 'string'
  ) {
    return `${pointer} must include ${error.params.missingProperty}.`;
  }
  if (
    error.keyword === 'additionalProperties' &&
    typeof error.params.additionalProperty === 'string'
  ) {
    return `${pointer} must not include ${error.params.additionalProperty}.`;
  }
  if (error.keyword === 'enum' && Array.isArray(error.schema)) {
    return `${pointer} must be one of ${error.schema.join(', ')}.`;
  }
  return `${pointer} ${error.message || 'is invalid'}.`;
}

function assertTransitionTargets(definition: WorkflowDefinition): void {
  const stepIds = new Set<string>();
  for (const step of definition.steps) {
    if (stepIds.has(step.id)) {
      throw new Error(
        `Invalid workflow definition: duplicate step id "${step.id}".`,
      );
    }
    stepIds.add(step.id);
  }

  for (const transition of definition.transitions) {
    if (!stepIds.has(transition.from)) {
      throw new Error(
        `Invalid workflow definition: transition references unknown from step "${transition.from}".`,
      );
    }
    if (!stepIds.has(transition.to)) {
      throw new Error(
        `Invalid workflow definition: transition references unknown to step "${transition.to}".`,
      );
    }
  }
}

export function validateWorkflowDefinition(value: unknown): WorkflowDefinition {
  if (!workflowDefinitionValidator(value)) {
    const message = (workflowDefinitionValidator.errors || [])
      .map(formatJsonSchemaError)
      .join(' ');
    throw new Error(`Invalid workflow definition: ${message}`);
  }
  assertTransitionTargets(value);
  return value;
}

export function parseWorkflowDefinitionYaml(
  raw: string,
  sourceName = 'workflow YAML',
): WorkflowDefinition {
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (error) {
    throw new Error(
      `Invalid ${sourceName}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  try {
    return validateWorkflowDefinition(parsed);
  } catch (error) {
    throw new Error(
      `Invalid ${sourceName}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
