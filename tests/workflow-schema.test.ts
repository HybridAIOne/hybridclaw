import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  parseWorkflowDefinitionYaml,
  validateWorkflowDefinition,
  WORKFLOW_DEFINITION_SCHEMA,
} from '../src/workflow/schema.js';

describe('workflow definition schema', () => {
  test('defines the required declarative workflow fields', () => {
    expect(WORKFLOW_DEFINITION_SCHEMA.required).toEqual([
      'id',
      'name',
      'steps',
      'transitions',
    ]);
    expect(WORKFLOW_DEFINITION_SCHEMA.properties.steps.items.required).toEqual([
      'id',
      'owner_coworker_id',
      'action',
    ]);
    expect(
      WORKFLOW_DEFINITION_SCHEMA.properties.steps.items.properties
        .stakes_threshold.enum,
    ).toEqual(['low', 'medium', 'high']);
  });

  test('parses a fixture workflow with a high-stakes step', () => {
    const fixture = fs.readFileSync(
      path.join(
        process.cwd(),
        'tests',
        'fixtures',
        'workflows',
        'launch-package.workflow.yaml',
      ),
      'utf-8',
    );

    const workflow = parseWorkflowDefinitionYaml(
      fixture,
      'launch-package.workflow.yaml',
    );

    expect(workflow.id).toBe('workflow_launch_package');
    expect(workflow.steps.map((step) => step.owner_coworker_id)).toEqual([
      'coworker_briefing',
      'coworker_builder',
      'coworker_reviewer',
    ]);
    expect(workflow.steps[2]).toMatchObject({
      id: 'review',
      stakes_threshold: 'high',
    });
    expect(workflow.transitions).toEqual([
      { from: 'brief', to: 'build' },
      { from: 'build', to: 'review' },
    ]);
  });

  test('rejects hard-coded approval booleans in steps', () => {
    expect(() =>
      parseWorkflowDefinitionYaml(`
id: workflow_invalid_approval
name: Invalid approval workflow
steps:
  - id: review
    owner_coworker_id: coworker_reviewer
    action: Review a client-visible response.
    requires_approval: true
transitions: []
`),
    ).toThrow(/must not include requires_approval/u);
  });

  test('rejects unknown transition targets', () => {
    expect(() =>
      validateWorkflowDefinition({
        id: 'workflow_invalid_transition',
        name: 'Invalid transition workflow',
        steps: [
          {
            id: 'brief',
            owner_coworker_id: 'coworker_briefing',
            action: 'Prepare the brief.',
          },
        ],
        transitions: [{ from: 'brief', to: 'missing' }],
      }),
    ).toThrow(/unknown to step "missing"/u);
  });
});
