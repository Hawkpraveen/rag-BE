import test from 'node:test';
import assert from 'node:assert/strict';
import { datasets } from '../src/controllers/ragController.js';

test('library metadata uses the active dataset version and returns filenames without local paths', async () => {
  const queries = [];
  const result = await datasets({
    list: async () => [{ datasetId: 'local-documents', versionId: 'active', documentCount: 1 }, { datasetId: 'empty' }],
    connect: async () => ({ collection(name) {
      assert.equal(name, 'documents');
      return { find(filter, options) {
        queries.push({ filter, options });
        return { toArray: async () => [{ _id: 'file-1', source: 'D:\\private\\policy.pdf', digest: 'internal' }] };
      } };
    } }),
  });
  assert.deepEqual(queries, [{ filter: { datasetId: 'local-documents', versionId: 'active' }, options: { projection: { _id: 1, source: 1 } } }]);
  assert.deepEqual(result.data.datasets[0].documents, [{ id: 'file-1', name: 'policy.pdf', type: 'pdf' }]);
  assert.deepEqual(result.data.datasets[1].documents, []);
  assert.equal(result.status, 200);
});
