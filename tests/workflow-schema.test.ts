import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  parseWorkflowDefinitionYaml,
  validateWorkflowDefinition,
} from '../src/workflow/schema.js';

describe('workflow definition schema', () => {
  test('rejects workflow documents missing required fields', () => {
    expect(() =>
      validateWorkflowDefinition({
        id: 'workflow_missing_name',
        steps: [
          {
            id: 'brief',
            owner_coworker_id: 'coworker_briefing',
            action: 'Prepare the brief.',
          },
        ],
        transitions: [{ from: 'brief', to: 'brief' }],
      }),
    ).toThrow(/must include name/u);
  });

  test('rejects steps missing required ownership fields', () => {
    expect(() =>
      validateWorkflowDefinition({
        id: 'workflow_missing_owner',
        name: 'Missing owner workflow',
        steps: [
          {
            id: 'brief',
            action: 'Prepare the brief.',
          },
        ],
        transitions: [{ from: 'brief', to: 'brief' }],
      }),
    ).toThrow(/must include owner_coworker_id/u);
  });

  test('rejects unsupported stakes thresholds', () => {
    expect(() =>
      validateWorkflowDefinition({
        id: 'workflow_invalid_stakes',
        name: 'Invalid stakes workflow',
        steps: [
          {
            id: 'brief',
            owner_coworker_id: 'coworker_briefing',
            action: 'Prepare the brief.',
            stakes_threshold: 'critical',
          },
        ],
        transitions: [{ from: 'brief', to: 'brief' }],
      }),
    ).toThrow(/stakes_threshold.*allowed values/u);
  });

  test('rejects workflow documents without transitions', () => {
    expect(() =>
      validateWorkflowDefinition({
        id: 'workflow_without_transitions',
        name: 'Workflow without transitions',
        steps: [
          {
            id: 'brief',
            owner_coworker_id: 'coworker_briefing',
            action: 'Prepare the brief.',
          },
        ],
        transitions: [],
      }),
    ).toThrow(/transitions.*fewer than 1 items/u);
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

    const workflow = parseWorkflowDefinitionYaml(fixture);

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

  test('rejects duplicate transitions', () => {
    expect(() =>
      validateWorkflowDefinition({
        id: 'workflow_duplicate_transition',
        name: 'Duplicate transition workflow',
        steps: [
          {
            id: 'brief',
            owner_coworker_id: 'coworker_briefing',
            action: 'Prepare the brief.',
          },
          {
            id: 'build',
            owner_coworker_id: 'coworker_builder',
            action: 'Build the artifact.',
          },
        ],
        transitions: [
          { from: 'brief', to: 'build' },
          { from: 'brief', to: 'build' },
        ],
      }),
    ).toThrow(/duplicate transition "brief" to "build"/u);
  });
});
