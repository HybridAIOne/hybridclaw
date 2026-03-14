import { expect, test } from 'vitest';

import { buildRoleSnapshotFromAriaSnapshot } from '../container/src/browser/ref-system.js';
import type { AriaNode } from '../container/src/browser/types.js';

const SAMPLE_ARIA_TREE: AriaNode[] = [
  {
    nodeId: '1',
    role: { value: 'RootWebArea' },
    childIds: ['2', '3', '4', '5'],
  },
  {
    nodeId: '2',
    parentId: '1',
    role: { value: 'heading' },
    name: { value: 'Mentions' },
    backendDOMNodeId: 12,
  },
  {
    nodeId: '3',
    parentId: '1',
    role: { value: 'button' },
    name: { value: 'Reply' },
    backendDOMNodeId: 13,
  },
  {
    nodeId: '4',
    parentId: '1',
    role: { value: 'button' },
    name: { value: 'Reply' },
    backendDOMNodeId: 14,
  },
  {
    nodeId: '5',
    parentId: '1',
    role: { value: 'generic' },
    childIds: ['6'],
  },
  {
    nodeId: '6',
    parentId: '5',
    role: { value: 'article' },
    name: { value: '@user mentioned you' },
    backendDOMNodeId: 16,
  },
];

test('ARIA snapshot assigns deterministic refs and tracks duplicate nth values', () => {
  const snapshot = buildRoleSnapshotFromAriaSnapshot(SAMPLE_ARIA_TREE, {
    compact: true,
  });

  expect(snapshot.text).toContain('@e1 heading "Mentions"');
  expect(snapshot.text).toContain('@e2 button "Reply"');
  expect(snapshot.text).toContain('@e3 button "Reply"');
  expect(snapshot.text).not.toContain('generic');

  const buttonRefs = Object.values(snapshot.refMap).filter(
    (ref) => ref.role === 'button',
  );
  expect(buttonRefs).toHaveLength(2);
  expect(buttonRefs.map((ref) => ref.nth)).toEqual([0, 1]);
});
