import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSettings, validateSnapshot, loadDataset } from '../src/services/mongodbData.js';

const snapshot = () => ({
  documents: [{ source: 'sample.md', digest: 'abc', model: 'test-model' }],
  chunks: [{ source: 'sample.md', location: 'text, character 1', text: 'Refund policy', vector: [1, 0] }],
});

test('accepts bare URIs and standard env files without overriding process settings', () => {
  assert.deepEqual(parseSettings('\uFEFFmongodb+srv://user:pass@cluster.example/'),
    { MONGODB_URI: 'mongodb+srv://user:pass@cluster.example/' });
  assert.equal(parseSettings('MONGODB_URI="mongodb://localhost:27017"\nMONGODB_DB=rag').MONGODB_DB, 'rag');
});

test('rejects mixed embedding spaces, corrupt vectors and orphan chunks before writes', () => {
  assert.deepEqual(validateSnapshot(snapshot()), { model: 'test-model', dimensions: 2 });
  const mixed = snapshot();
  mixed.documents.push({ source: 'other.md', digest: 'def', model: 'other-model' });
  assert.throws(() => validateSnapshot(mixed), /exactly one/);
  for (const vector of [[0, 0], [NaN, 1], [Infinity, 1], [1]]) {
    const invalid = snapshot();
    invalid.chunks.push({ ...invalid.chunks[0], vector });
    assert.throws(() => validateSnapshot(invalid), /Invalid chunk/);
  }
  const orphan = snapshot(); orphan.chunks[0].source = 'missing.md';
  assert.throws(() => validateSnapshot(orphan), /Invalid chunk/);
});

function fakeDatabase(queryable) {
  const writes = [];
  const collections = new Map();
  return { writes, collection(name) {
    if (!collections.has(name)) collections.set(name, {
      createIndex: async () => {},
      updateOne: async (filter, update) => { writes.push({ name, filter, update }); },
      bulkWrite: async operations => { writes.push({ name, operations }); },
      findOne: async () => null,
      listSearchIndexes: () => ({ toArray: async () => [{ queryable }] }),
      aggregate: pipeline => ({ toArray: async () => {
        assert.equal(pipeline[0].$vectorSearch.filter.datasetId, 'sample');
        return [{ _id: 'chunk' }];
      } }),
    });
    return collections.get(name);
  } };
}

test('publishes only a queryable build and repeated imports use stable IDs', async () => {
  const db = fakeDatabase(true);
  const first = await loadDataset(db, snapshot(), 'sample', { waitMS: 0 });
  const second = await loadDataset(db, snapshot(), 'sample', { waitMS: 0 });
  assert.equal(first.buildId, second.buildId);
  assert.equal(first.chunkCount, 1);
  assert.equal(db.writes.filter(w => w.name === 'datasets').length, 2);
  const changed = snapshot(); changed.chunks[0].text = 'Changed policy';
  assert.notEqual((await loadDataset(db, changed, 'sample', { waitMS: 0 })).versionId, first.versionId);
});

test('an unready index preserves the previously published dataset', async () => {
  const db = fakeDatabase(false);
  await assert.rejects(loadDataset(db, snapshot(), 'sample', { waitMS: 0 }), /not ready/);
  assert.equal(db.writes.some(w => w.name === 'datasets'), false);
  assert.equal(db.writes.at(-1).update.$set.status, 'failed');
});
