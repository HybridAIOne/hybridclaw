import { expect, test } from 'vitest';
import { resolveStaticModelCatalogMetadata as read } from '../src/providers/model-metadata.js';
import { getModelCatalogMetadata } from '../src/providers/model-catalog.js';

test.each(['nebius/zai-org/GLM-5.3', 'nebius/zai-org/glm-5.3'])('metadata: %s', m => {
 expect(read(m).contextWindow).toBe(1048576);
 expect(read(m).capabilities.vision).toBe(false);
 expect(getModelCatalogMetadata(m).contextWindow).toBe(1048576);
});

test('others stay unknown', () => {
 expect(read('nebius/zai-org/GLM-5.3-Flash').known).toBe(false);
 expect(read('example').known).toBe(false);
});
